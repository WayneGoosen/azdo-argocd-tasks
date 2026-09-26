// The `manifests` command.
//
// "Live" is not a mode of the manifests endpoint. GET /manifests only ever returns the
// DESIRED (git) manifests; the argocd CLI implements `--source live` by reading liveState
// out of managed-resources. Since the diff command already uses that endpoint, live
// manifests cost no new API surface.
//
// Manifests arrive as JSON-encoded STRINGS, so each needs parsing before it can be
// pretty-printed -- the same trap as the diff state fields.

import * as tl from 'azure-pipelines-task-lib/task';
import {
    echoBounded,
    safeFileName,
    uploadArtifact,
    writeOutputFile,
} from '@azdo-argocd/task-common';
import { OperationContext, OperationOutcome, fetchSnapshots, resolveApplications } from './context';

const ECHO_LINE_LIMIT = 100;

/** Pretty-print a JSON-encoded manifest, leaving it untouched if it is not JSON after all. */
export function formatManifest(raw: string): string {
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
}

/** Join manifests into one document, separated the way a multi-document YAML file would be. */
export function joinManifests(manifests: readonly string[]): string {
    return manifests.map(formatManifest).join('\n---\n');
}

export async function runManifests(ctx: OperationContext): Promise<OperationOutcome> {
    const refs = await resolveApplications(ctx);
    const source = (tl.getInput('manifestSource', false) ?? 'git').toLowerCase();
    const revision = tl.getInput('revision', false) || undefined;
    const artifactName = (tl.getInput('artifactName', false) ?? 'argocd-manifests').trim();

    if (source === 'live' && revision !== undefined) {
        tl.warning(
            'A revision was supplied with manifestSource "live". Live state has no revision to ' +
                'select, so the revision is ignored. Use manifestSource "git" to render a revision.',
        );
    }

    let totalManifests = 0;
    const files: string[] = [];

    for (const ref of refs) {
        const query = { appNamespace: ref.appNamespace, project: ctx.common.project };
        let documents: string[];

        if (source === 'live') {
            const managed = await ctx.client.getManagedResources(ref.name, query);
            documents = (managed.items ?? [])
                .map((item) => item.liveState)
                .filter((state): state is string => state !== undefined && state.trim() !== '');
        } else {
            const response = await ctx.client.getManifests(
                ref.name,
                revision === undefined ? {} : { revision },
                query,
            );
            documents = response.manifests ?? [];
            if (response.revision !== undefined && response.revision !== '') {
                console.log(`${ref.name}: rendered at revision ${response.revision}`);
            }
        }

        totalManifests += documents.length;
        const content = joinManifests(documents);
        const filePath = writeOutputFile(`${safeFileName(ref.name)}-${source}-manifests.json`, content);
        files.push(filePath);

        console.log(`${ref.name}: ${documents.length} manifest(s) -> ${filePath}`);
        // The full set goes to the artifact; only a readable slice goes to the log.
        echoBounded(content, ECHO_LINE_LIMIT, filePath);
        uploadArtifact(filePath, artifactName);
    }

    const snapshots = await fetchSnapshots(ctx, refs);
    return {
        decision: {
            verdict: 'succeeded',
            message: `Rendered ${totalManifests} manifest(s) from ${refs.length} application(s)`,
        },
        snapshots,
        summary: undefined,
        extraOutputs: {
            manifestCount: String(totalManifests),
            manifestFile: files.length === 1 ? (files[0] as string) : '',
        },
    };
}
