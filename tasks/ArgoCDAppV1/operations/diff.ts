// The `diff` command.

import * as tl from 'azure-pipelines-task-lib/task';
import { ResourceDiff } from '@azdo-argocd/argocd-client';
import { AttachmentDiff, Decision, aggregate, decideFromDiff, renderDiffSummary, toAttachmentDiffs } from '@azdo-argocd/task-common';
import { OperationContext, OperationOutcome, fetchSnapshots, resolveApplications } from './context';

export async function runDiff(ctx: OperationContext): Promise<OperationOutcome> {
    const refs = await resolveApplications(ctx);
    const failOnDiff = tl.getBoolInput('failOnDiff', false);

    const decisions: Decision[] = [];
    const summaries: string[] = [];
    const diffs: AttachmentDiff[] = [];
    let totalChanged = 0;

    for (const ref of refs) {
        const managed = await ctx.client.getManagedResources(ref.name, {
            appNamespace: ref.appNamespace,
            project: ctx.common.project,
        });
        const resources: ResourceDiff[] = managed.items ?? [];
        const changed = resources.filter((resource) => resource.modified === true).length;
        totalChanged += changed;

        decisions.push(decideFromDiff(changed, failOnDiff));
        diffs.push(...toAttachmentDiffs(resources));
        summaries.push(
            renderDiffSummary({
                applicationName: ref.name,
                serverUrl: ctx.serverUrl,
                appNamespace: ref.appNamespace,
                resources,
            }),
        );
    }

    const snapshots = await fetchSnapshots(ctx, refs);

    return {
        decision: aggregate(decisions),
        snapshots,
        summary: summaries.join('\n\n---\n\n'),
        extraOutputs: {
            hasDiff: String(totalChanged > 0),
            diffResourceCount: String(totalChanged),
        },
        attachment: { diffs },
    };
}
