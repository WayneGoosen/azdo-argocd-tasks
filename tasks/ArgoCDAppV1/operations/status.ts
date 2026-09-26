// The `get` and `refresh` commands.

import * as tl from 'azure-pipelines-task-lib/task';
import { decideFromStatus, renderStatusSummary } from '@azdo-argocd/task-common';
import { OperationContext, OperationOutcome, fetchSnapshots, fetchUnhealthyNodes, resolveApplications } from './context';

export async function runGet(ctx: OperationContext, refresh?: 'normal' | 'hard'): Promise<OperationOutcome> {
    const refs = await resolveApplications(ctx);
    const snapshots = await fetchSnapshots(ctx, refs, refresh);

    const failOnHealth = (tl.getInput('failOnHealth', false) ?? 'Degraded,Missing')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== '');

    const decision = decideFromStatus(
        snapshots.map((snapshot) => ({
            name: snapshot.name,
            syncStatus: snapshot.syncStatus,
            healthStatus: snapshot.healthStatus,
        })),
        { failOnOutOfSync: tl.getBoolInput('failOnOutOfSync', false), failOnHealth },
    );

    const unhealthyNodes = decision.verdict === 'failed' ? await fetchUnhealthyNodes(ctx, refs) : [];

    return {
        decision,
        snapshots,
        summary: renderStatusSummary({
            title: refresh === undefined ? 'Argo CD application status' : 'Argo CD application status (refreshed)',
            serverUrl: ctx.serverUrl,
            snapshots,
            unhealthyNodes,
        }),
        extraOutputs: {},
    };
}
