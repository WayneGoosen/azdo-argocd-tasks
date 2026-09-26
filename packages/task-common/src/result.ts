// Mapping Argo CD state onto an Azure Pipelines task result.
//
// Kept as one pure function over an explicit input record so the whole policy is visible
// in one place and testable as a truth table. The rules come from the PRD:
//
//   Failed                -- Degraded / Missing, a Failed or Error operation, or a timeout
//   SucceededWithIssues   -- Progressing at timeout with failOnTimeout=false,
//                            OutOfSync with failOnOutOfSync=false,
//                            a diff with changes and failOnDiff=false
//   Succeeded             -- the requested conditions were met

import { WaitResult } from './wait';

export type Verdict = 'succeeded' | 'succeededWithIssues' | 'failed';

export interface Decision {
    verdict: Verdict;
    message: string;
}

export interface WaitPolicy {
    /** When false a timeout downgrades to SucceededWithIssues instead of failing. */
    failOnTimeout: boolean;
}

export function decideFromWait(result: WaitResult, policy: WaitPolicy): Decision {
    switch (result.outcome) {
        case 'satisfied':
            return { verdict: 'succeeded', message: result.reason };
        case 'failed':
            return { verdict: 'failed', message: result.reason };
        case 'timedOut':
            return {
                verdict: policy.failOnTimeout ? 'failed' : 'succeededWithIssues',
                message: result.reason,
            };
        default:
            return { verdict: 'failed', message: 'Unknown wait outcome' };
    }
}

export interface StatusPolicy {
    failOnOutOfSync: boolean;
    /** Health statuses that fail the task, e.g. ["Degraded", "Missing"]. */
    failOnHealth: string[];
}

export interface StatusInput {
    name: string;
    syncStatus: string | undefined;
    healthStatus: string | undefined;
}

/** Verdict for a non-waiting status read (the `get` command). */
export function decideFromStatus(apps: readonly StatusInput[], policy: StatusPolicy): Decision {
    const unhealthy = apps.filter(
        (app) => app.healthStatus !== undefined && policy.failOnHealth.includes(app.healthStatus),
    );
    if (unhealthy.length > 0) {
        const detail = unhealthy.map((app) => `${app.name}=${app.healthStatus}`).join(', ');
        return { verdict: 'failed', message: `Unhealthy application(s): ${detail}` };
    }

    const outOfSync = apps.filter((app) => app.syncStatus === 'OutOfSync');
    if (outOfSync.length > 0) {
        const detail = outOfSync.map((app) => app.name).join(', ');
        return {
            verdict: policy.failOnOutOfSync ? 'failed' : 'succeededWithIssues',
            message: `Out of sync: ${detail}`,
        };
    }

    return { verdict: 'succeeded', message: `${apps.length} application(s) synced and healthy` };
}

/** Verdict for the `diff` command. */
export function decideFromDiff(changedResourceCount: number, failOnDiff: boolean): Decision {
    if (changedResourceCount === 0) {
        return { verdict: 'succeeded', message: 'No differences between desired and live state' };
    }
    return {
        verdict: failOnDiff ? 'failed' : 'succeededWithIssues',
        message: `${changedResourceCount} resource(s) differ from the desired state`,
    };
}

/** A run covering several applications fails if any single application fails. */
export function aggregate(decisions: readonly Decision[]): Decision {
    const failed = decisions.filter((d) => d.verdict === 'failed');
    if (failed.length > 0) {
        return { verdict: 'failed', message: failed.map((d) => d.message).join('; ') };
    }
    const withIssues = decisions.filter((d) => d.verdict === 'succeededWithIssues');
    if (withIssues.length > 0) {
        return { verdict: 'succeededWithIssues', message: withIssues.map((d) => d.message).join('; ') };
    }
    return { verdict: 'succeeded', message: decisions.map((d) => d.message).join('; ') };
}
