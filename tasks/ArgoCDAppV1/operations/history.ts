// The `history` command.
//
// There is no history endpoint in the Argo CD API -- `argocd app history` simply reads
// status.history[] off the application, and so does this. The list is capped by
// spec.revisionHistoryLimit (default 10), so an empty result can mean "never synced"
// rather than "no data".

import { RevisionHistory } from '@azdo-argocd/argocd-client';
import { renderHistorySummary } from '@azdo-argocd/task-common';
import { OperationContext, OperationOutcome, resolveApplications, toSnapshot } from './context';

/** History entries newest first. `id` is an int64 upstream, so it may arrive as a string. */
export function sortHistory(entries: readonly RevisionHistory[]): RevisionHistory[] {
    return [...entries].sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));
}

/**
 * Pick the history entry a rollback should target.
 *
 * `previous` means the deployment before the current one -- the second-newest entry, not
 * the second-oldest. Getting this backwards would roll production back to its first ever
 * deploy, so it is pinned by tests.
 */
export function selectHistoryId(entries: readonly RevisionHistory[], requested: string): number {
    const sorted = sortHistory(entries);

    if (requested.toLowerCase() === 'previous') {
        if (sorted.length < 2) {
            throw new Error(
                `Cannot roll back to the previous revision: the application has ${sorted.length} ` +
                    'history entry. At least two deployments are needed.',
            );
        }
        return Number(sorted[1]?.id ?? 0);
    }

    const requestedId = Number.parseInt(requested, 10);
    if (Number.isNaN(requestedId)) {
        throw new Error(`"${requested}" is not a valid history ID. Use a number, or "previous".`);
    }
    if (!sorted.some((entry) => Number(entry.id ?? -1) === requestedId)) {
        const available = sorted.map((entry) => entry.id).join(', ');
        throw new Error(
            `History ID ${requestedId} does not exist for this application. Available IDs: ${available || 'none'}.`,
        );
    }
    return requestedId;
}

export async function runHistory(ctx: OperationContext): Promise<OperationOutcome> {
    const refs = await resolveApplications(ctx);

    const summaries: string[] = [];
    const snapshots = [];
    let latestHistoryId = '';

    for (const ref of refs) {
        const app = await ctx.client.getApplication(ref.name, {
            appNamespace: ref.appNamespace,
            project: ctx.common.project,
        });
        const entries = sortHistory(app.status?.history ?? []);
        snapshots.push(toSnapshot(app, ref.name));

        if (refs.length === 1 && entries.length > 0) {
            latestHistoryId = String(entries[0]?.id ?? '');
        }

        console.log(`${ref.name}: ${entries.length} history entr${entries.length === 1 ? 'y' : 'ies'}`);
        for (const entry of entries) {
            console.log(`  ${entry.id}  ${entry.revision ?? '-'}  ${entry.deployedAt ?? '-'}`);
        }

        summaries.push(
            renderHistorySummary({
                applicationName: ref.name,
                serverUrl: ctx.serverUrl,
                appNamespace: ref.appNamespace,
                entries,
            }),
        );
    }

    return {
        decision: { verdict: 'succeeded', message: `Read history for ${refs.length} application(s)` },
        snapshots,
        summary: summaries.join('\n\n---\n\n'),
        extraOutputs: latestHistoryId === '' ? {} : { latestHistoryId },
    };
}
