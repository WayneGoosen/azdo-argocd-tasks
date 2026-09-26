// The `sync` command.

import * as tl from 'azure-pipelines-task-lib/task';
import { SyncRequest } from '@azdo-argocd/argocd-client';
import { getBoolInputOrDefault, renderStatusSummary, waitForApplications } from '@azdo-argocd/task-common';
import { ApplicationRef, WaitInputs, parseResources } from '../inputs';
import { OperationContext, OperationOutcome, fetchSnapshots, resolveApplications } from './context';
import { runWait } from './wait';

/**
 * Deal with an operation already running on the application.
 *
 * Argo CD rejects a sync while another operation is in flight, and the default failure is
 * opaque, so this is surfaced as an explicit choice rather than an error to decode.
 */
async function handleRunningOperation(
    ctx: OperationContext,
    ref: ApplicationRef,
    policy: string,
): Promise<void> {
    const app = await ctx.client.getApplication(ref.name, {
        appNamespace: ref.appNamespace,
        project: ctx.common.project,
    });
    if (app.status?.operationState?.phase !== 'Running') {
        return;
    }

    if (policy === 'terminate') {
        console.log(`Terminating the in-flight operation on "${ref.name}" before syncing.`);
        await ctx.client.terminateOperation(ref.name, {
            appNamespace: ref.appNamespace,
            project: ctx.common.project,
        });
        return;
    }

    if (policy === 'wait') {
        console.log(`Waiting for the in-flight operation on "${ref.name}" to finish before syncing.`);
        await waitForApplications({
            conditions: ['operation'],
            timeoutSeconds: ctx.common.timeoutSeconds,
            poll: () => fetchSnapshots(ctx, [ref]),
        });
        return;
    }

    throw new Error(
        `Application "${ref.name}" already has an operation in progress. ` +
            'Set "onRunningOperation" to "wait" or "terminate" to handle this automatically.',
    );
}

export async function runSync(ctx: OperationContext, waitInputs: WaitInputs): Promise<OperationOutcome> {
    const refs = await resolveApplications(ctx);

    const syncBody: SyncRequest = {
        revision: tl.getInput('revision', false) || undefined,
        prune: tl.getBoolInput('prune', false),
        dryRun: tl.getBoolInput('dryRun', false),
        resources: parseResources(tl.getDelimitedInput('resources', '\n', false)),
        syncOptions: tl
            .getDelimitedInput('syncOptions', '\n', false)
            .map((option) => option.trim())
            .filter((option) => option !== ''),
    };

    const strategy = (tl.getInput('syncStrategy', false) ?? 'apply').toLowerCase();
    const force = tl.getBoolInput('force', false);
    syncBody.strategy =
        strategy === 'hook' ? { hook: { syncStrategyApply: { force } } } : { apply: { force } };

    const retryLimit = Number.parseInt(tl.getInput('retryLimit', false) ?? '0', 10);
    if (!Number.isNaN(retryLimit) && retryLimit > 0) {
        syncBody.retryStrategy = { limit: retryLimit };
    }

    const onRunningOperation = (tl.getInput('onRunningOperation', false) ?? 'fail').toLowerCase();

    for (const ref of refs) {
        await handleRunningOperation(ctx, ref, onRunningOperation);
        console.log(`Syncing "${ref.name}"${syncBody.dryRun === true ? ' (dry run)' : ''}...`);
        await ctx.client.syncApplication(ref.name, syncBody, {
            appNamespace: ref.appNamespace,
            project: ctx.common.project,
        });
    }

    // A dry run never changes anything, so there is nothing to converge on.
    const shouldWait = getBoolInputOrDefault('wait', true) && syncBody.dryRun !== true;
    if (!shouldWait) {
        const snapshots = await fetchSnapshots(ctx, refs);
        return {
            decision: { verdict: 'succeeded', message: `Sync requested for ${refs.length} application(s)` },
            snapshots,
            summary: renderStatusSummary({
                title: 'Argo CD sync requested',
                serverUrl: ctx.serverUrl,
                snapshots,
            }),
            extraOutputs: {},
        };
    }

    return runWait(ctx, waitInputs);
}
