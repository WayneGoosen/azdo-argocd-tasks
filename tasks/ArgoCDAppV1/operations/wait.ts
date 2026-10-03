// The `wait` command.

import { decideFromWait, renderStatusSummary, toAttachmentResources, waitForApplications } from '@azdo-argocd/task-common';
import { WaitInputs } from '../inputs';
import { OperationContext, OperationOutcome, fetchSnapshots, fetchUnhealthyNodes, resolveApplications } from './context';

export async function runWait(ctx: OperationContext, waitInputs: WaitInputs): Promise<OperationOutcome> {
    const refs = await resolveApplications(ctx);
    const result = await waitForApplications({
        conditions: waitInputs.conditions,
        timeoutSeconds: waitInputs.timeoutSeconds,
        pollIntervalMs: waitInputs.pollIntervalSeconds * 1000,
        poll: () => fetchSnapshots(ctx, refs),
        onPoll: (snapshots, elapsedMs) => {
            const summary = snapshots
                .map((s) => `${s.name}: sync=${s.syncStatus ?? '?'} health=${s.healthStatus ?? '?'}`)
                .join(' | ');
            console.log(`[${Math.round(elapsedMs / 1000)}s] ${summary}`);
        },
    });

    const decision = decideFromWait(result, { failOnTimeout: waitInputs.failOnTimeout });
    const unhealthyNodes = decision.verdict === 'failed' ? await fetchUnhealthyNodes(ctx, refs) : [];

    return {
        decision,
        snapshots: result.snapshots,
        summary: renderStatusSummary({
            title: `Argo CD wait (${waitInputs.conditions.join(', ')})`,
            serverUrl: ctx.serverUrl,
            snapshots: result.snapshots,
            unhealthyNodes,
            footer: `Completed in ${Math.round(result.elapsedMs / 1000)}s over ${result.polls} poll(s).`,
        }),
        extraOutputs: {},
        attachment: { unhealthy: toAttachmentResources(unhealthyNodes) },
    };
}
