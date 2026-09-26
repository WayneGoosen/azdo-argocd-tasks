// The `logs` command.
//
// Reading Argo CD pod logs over REST has three sharp edges, all handled in the client's
// stream parser: the payload is wrapped in a {"result":...} envelope, errors arrive
// MID-STREAM with HTTP 200 because headers are already flushed, and the end of the stream
// is marked by an entry with last:true rather than simply by EOF.
//
// Two more worth knowing here:
//   * Logs need the separate `logs` RBAC resource. A token that can read applications can
//     still be denied logs, which is a confusing 403 unless it is named.
//   * With no resource specified, the server streams EVERY pod in the application,
//     interleaved. That is useful, but it means output is bounded by tailLines per stream,
//     not overall.

import * as tl from 'azure-pipelines-task-lib/task';
import { ResourceRef, formatLogEntries } from '@azdo-argocd/argocd-client';
import {
    echoBounded,
    safeFileName,
    uploadArtifact,
    writeOutputFile,
} from '@azdo-argocd/task-common';
import { getPositiveInt, parseResources } from '../inputs';
import { OperationContext, OperationOutcome, fetchSnapshots, resolveApplications } from './context';

const ECHO_LINE_LIMIT = 200;

/** Optional resource filter; absent means "every pod in the application". */
export function readOptionalResource(): ResourceRef | undefined {
    const parsed = parseResources(tl.getDelimitedInput('resource', '\n', false));
    if (parsed.length === 0) {
        return undefined;
    }
    if (parsed.length > 1) {
        throw new Error('Specify at most one resource when reading logs.');
    }
    return parsed[0] as ResourceRef;
}

export async function runLogs(ctx: OperationContext): Promise<OperationOutcome> {
    const refs = await resolveApplications(ctx);
    if (refs.length !== 1) {
        throw new Error(
            `Logs are read from a single application, but ${refs.length} were selected. ` +
                'Name one application rather than using a selector.',
        );
    }

    const ref = refs[0] as { name: string; appNamespace: string | undefined };
    const artifactName = (tl.getInput('artifactName', false) ?? 'argocd-logs').trim();

    const options = {
        resource: readOptionalResource(),
        podName: tl.getInput('podName', false) || undefined,
        container: tl.getInput('container', false) || undefined,
        tailLines: getPositiveInt('tailLines', 1000),
        sinceSeconds: tl.getInput('sinceSeconds', false)
            ? getPositiveInt('sinceSeconds', 0)
            : undefined,
        previous: tl.getBoolInput('previous', false),
        filter: tl.getInput('logFilter', false) || undefined,
    };

    const stream = await ctx.client.getPodLogs(ref.name, options, {
        appNamespace: ref.appNamespace,
        project: ctx.common.project,
    });

    if (stream.entries.length === 0) {
        // An empty stream and "no pods matched" are indistinguishable server-side, so say so.
        tl.warning(
            'No log entries were returned. Either the pods have produced no output yet, or nothing ' +
                'matched the resource filter. Check the "resource", "podName" and "container" inputs.',
        );
    }
    if (!stream.complete && stream.entries.length > 0) {
        tl.warning('The log stream ended without a terminator, so output may be truncated.');
    }
    if (stream.malformedLines > 0) {
        tl.debug(`${stream.malformedLines} unparseable line(s) in the log stream were skipped.`);
    }

    const content = formatLogEntries(stream.entries);
    const filePath = writeOutputFile(`${safeFileName(ref.name)}-logs.txt`, content);

    console.log(`${ref.name}: ${stream.entries.length} log line(s) -> ${filePath}`);
    echoBounded(content, ECHO_LINE_LIMIT, filePath);
    uploadArtifact(filePath, artifactName);

    const snapshots = await fetchSnapshots(ctx, refs);
    return {
        decision: {
            verdict: 'succeeded',
            message: `Collected ${stream.entries.length} log line(s) from ${ref.name}`,
        },
        snapshots,
        summary: undefined,
        extraOutputs: { logLineCount: String(stream.entries.length), logFile: filePath },
    };
}
