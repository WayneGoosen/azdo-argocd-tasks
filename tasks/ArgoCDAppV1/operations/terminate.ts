// The `terminate` command -- cancel an in-flight operation.
//
// Note the verb is DELETE, not POST, and the response is empty. The client call already
// existed for `onRunningOperation: terminate` during sync; this exposes it directly for
// the case where a previous run left an operation stuck.

import { renderStatusSummary } from '@azdo-argocd/task-common';
import { OperationContext, OperationOutcome, fetchSnapshots, resolveApplications } from './context';

export async function runTerminate(ctx: OperationContext): Promise<OperationOutcome> {
    const refs = await resolveApplications(ctx);
    let terminated = 0;

    for (const ref of refs) {
        const app = await ctx.client.getApplication(ref.name, {
            appNamespace: ref.appNamespace,
            project: ctx.common.project,
        });

        if (app.status?.operationState?.phase !== 'Running') {
            console.log(`${ref.name}: no operation in progress, nothing to terminate.`);
            continue;
        }

        console.log(`${ref.name}: terminating the in-flight operation...`);
        await ctx.client.terminateOperation(ref.name, {
            appNamespace: ref.appNamespace,
            project: ctx.common.project,
        });
        terminated += 1;
    }

    const snapshots = await fetchSnapshots(ctx, refs);
    return {
        decision: {
            verdict: 'succeeded',
            message:
                terminated === 0
                    ? 'No operations were in progress'
                    : `Terminated ${terminated} operation(s)`,
        },
        snapshots,
        summary: renderStatusSummary({
            title: 'Argo CD terminate operation',
            serverUrl: ctx.serverUrl,
            snapshots,
        }),
        extraOutputs: { terminatedCount: String(terminated) },
    };
}
