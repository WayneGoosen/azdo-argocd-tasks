// The `rollback` command.
//
// Rollback is sugar over sync server-side: it sets an operation and returns immediately,
// so the outcome has to be polled exactly as after a sync. That is why this reuses the
// wait engine rather than inventing its own loop.
//
// The failure worth knowing about: Argo CD REFUSES to roll back an application with
// automated sync enabled, because the controller would immediately sync it forward again.
// The client turns that into an actionable message.

import * as tl from 'azure-pipelines-task-lib/task';
import { renderStatusSummary } from '@azdo-argocd/task-common';
import { WaitInputs } from '../inputs';
import { OperationContext, OperationOutcome, fetchSnapshots, resolveApplications } from './context';
import { selectHistoryId } from './history';
import { runWait } from './wait';

export async function runRollback(
    ctx: OperationContext,
    waitInputs: WaitInputs,
): Promise<OperationOutcome> {
    const refs = await resolveApplications(ctx);
    const requested = (tl.getInput('historyId', false) ?? 'previous').trim();
    const prune = tl.getBoolInput('prune', false);
    const dryRun = tl.getBoolInput('dryRun', false);

    const rolledBackTo: string[] = [];

    for (const ref of refs) {
        const app = await ctx.client.getApplication(ref.name, {
            appNamespace: ref.appNamespace,
            project: ctx.common.project,
        });

        if (app.spec?.syncPolicy?.automated !== undefined) {
            // Fail before the request rather than after, so the message is the first thing
            // in the log rather than buried under a server error.
            throw new Error(
                `Application "${ref.name}" has automated sync enabled, and Argo CD refuses to roll ` +
                    'back such an application because the controller would immediately sync it forward ' +
                    'again. Either disable automated sync for the rollback, or revert in Git and let ' +
                    'Argo CD sync that -- the GitOps-native route, and the one that leaves an audit trail.',
            );
        }

        const id = selectHistoryId(app.status?.history ?? [], requested);
        console.log(`Rolling "${ref.name}" back to history ID ${id}${dryRun ? ' (dry run)' : ''}...`);

        await ctx.client.rollbackApplication(
            ref.name,
            { id, prune, dryRun },
            { appNamespace: ref.appNamespace, project: ctx.common.project },
        );
        rolledBackTo.push(String(id));
    }

    const extraOutputs: Record<string, string> =
        refs.length === 1 ? { rolledBackTo: rolledBackTo[0] as string } : {};

    // A dry run changes nothing, so there is nothing to converge on.
    if (dryRun) {
        const snapshots = await fetchSnapshots(ctx, refs);
        return {
            decision: { verdict: 'succeeded', message: `Rollback dry run for ${refs.length} application(s)` },
            snapshots,
            summary: renderStatusSummary({
                title: 'Argo CD rollback (dry run)',
                serverUrl: ctx.serverUrl,
                snapshots,
            }),
            extraOutputs,
        };
    }

    const outcome = await runWait(ctx, waitInputs);
    return { ...outcome, extraOutputs: { ...outcome.extraOutputs, ...extraOutputs } };
}
