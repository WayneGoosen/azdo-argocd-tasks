// The `create` command -- create or upsert Applications from a manifest file.
//
// Multi-document YAML is supported so an app-of-apps bootstrap file works in one step.
//
// Two server behaviours worth knowing:
//   * `upsert` and `validate` are QUERY parameters, not body fields.
//   * Creating an application identical to an existing one is idempotent -- the server
//     returns 200 and changes nothing. Creating a DIFFERENT one without upsert is
//     rejected, and upsert additionally requires `update` RBAC, so a create-only token
//     fails at that point rather than at the start.

import * as fs from 'node:fs';
import * as tl from 'azure-pipelines-task-lib/task';
import { getBoolInputOrDefault, manifestName, parseKubernetesManifests } from '@azdo-argocd/task-common';
import { OperationContext, OperationOutcome, toSnapshot } from './context';

const APPLICATION_KIND = 'Application';

export async function runCreate(ctx: OperationContext): Promise<OperationOutcome> {
    const manifestFile = tl.getPathInput('manifestFile', true, true);
    if (manifestFile === undefined) {
        throw new Error('The "manifestFile" input is required for the create command.');
    }

    const upsert = tl.getBoolInput('upsert', false);
    const validate = getBoolInputOrDefault('validate', true);

    const applications = parseKubernetesManifests(
        fs.readFileSync(manifestFile, 'utf8'),
        manifestFile,
        APPLICATION_KIND,
    );
    console.log(`${manifestFile}: ${applications.length} Application manifest(s)`);

    const snapshots = [];
    const names: string[] = [];

    for (const application of applications) {
        const name = manifestName(application);
        console.log(`Creating "${name}"${upsert ? ' (upsert)' : ''}...`);

        const created = await ctx.client.createApplication(application, { upsert, validate });
        names.push(name);
        snapshots.push(toSnapshot(created, name));
    }

    return {
        decision: {
            verdict: 'succeeded',
            message: `Created or updated ${names.length} application(s): ${names.join(', ')}`,
        },
        snapshots,
        summary: undefined,
        extraOutputs: {
            createdCount: String(names.length),
            ...(names.length === 1 ? { appName: names[0] as string } : {}),
        },
    };
}
