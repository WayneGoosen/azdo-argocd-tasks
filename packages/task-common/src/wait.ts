// The wait engine.
//
// This is the heart of the extension: almost every useful pipeline step is "do a thing,
// then block until Argo CD says it worked". It is deliberately pure -- clock, sleep,
// randomness and the poll itself are all injected -- so timeout, backoff and jitter are
// tested deterministically instead of with real timers.
//
// Polling, not the streaming watch endpoint: long-lived streams are cut by App Gateway
// and NGINX idle timeouts, while a poll survives proxies and agent network blips.
//
// On terminal states, note the asymmetry:
//   * A FAILED OPERATION is terminal. The sync itself errored; waiting cannot fix it.
//   * DEGRADED / MISSING health is NOT terminal by default. Both occur transiently
//     during a normal rollout, and failing fast on them makes deployments flaky. They
//     fail the task by being the state at timeout, which is what the exit-code rules say.
//     `failFastOnDegraded` opts into the stricter behaviour.

import { HealthStatusCode, OperationPhase, SyncStatusCode } from '@azdo-argocd/argocd-client';

export type WaitCondition = 'sync' | 'health' | 'operation' | 'suspended';

export interface AppSnapshot {
    name: string;
    namespace?: string | undefined;
    /** spec.project. The tab shows it, and it disambiguates same-named apps. */
    project?: string | undefined;
    syncStatus?: SyncStatusCode | undefined;
    healthStatus?: HealthStatusCode | undefined;
    healthMessage?: string | undefined;
    operationPhase?: OperationPhase | undefined;
    operationMessage?: string | undefined;
    revision?: string | undefined;
    /** One per source; a multi-source app has several. */
    revisions?: string[] | undefined;
}

export type WaitOutcome = 'satisfied' | 'timedOut' | 'failed';

export interface WaitResult {
    outcome: WaitOutcome;
    snapshots: AppSnapshot[];
    /** Human-readable explanation, suitable for a task result message. */
    reason: string;
    elapsedMs: number;
    polls: number;
}

export interface WaitOptions {
    conditions: WaitCondition[];
    timeoutSeconds: number;
    pollIntervalMs?: number;
    failFastOnDegraded?: boolean;
    poll: () => Promise<AppSnapshot[]>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    onPoll?: (snapshots: AppSnapshot[], elapsedMs: number) => void;
}

export const DEFAULT_POLL_INTERVAL_MS = 5_000;

const TERMINAL_OPERATION_PHASES: ReadonlySet<OperationPhase> = new Set<OperationPhase>(['Failed', 'Error']);
const UNHEALTHY_STATUSES: ReadonlySet<HealthStatusCode> = new Set<HealthStatusCode>(['Degraded', 'Missing']);

export function isConditionMet(
    snapshot: AppSnapshot,
    condition: WaitCondition,
    conditions: readonly WaitCondition[],
): boolean {
    switch (condition) {
        case 'sync':
            return snapshot.syncStatus === 'Synced';
        case 'health':
            // Suspended satisfies health only when the caller explicitly asked to accept
            // it -- that is the Argo Rollouts pause case.
            return (
                snapshot.healthStatus === 'Healthy' ||
                (conditions.includes('suspended') && snapshot.healthStatus === 'Suspended')
            );
        case 'operation':
            return snapshot.operationPhase === undefined || snapshot.operationPhase === 'Succeeded';
        case 'suspended':
            return snapshot.healthStatus === 'Suspended';
        default:
            return false;
    }
}

export function areAllConditionsMet(snapshot: AppSnapshot, conditions: readonly WaitCondition[]): boolean {
    return conditions.every((condition) => isConditionMet(snapshot, condition, conditions));
}

/** A state no amount of further waiting can improve. */
export function findTerminalFailure(
    snapshots: readonly AppSnapshot[],
    failFastOnDegraded: boolean,
): AppSnapshot | undefined {
    return snapshots.find((snapshot) => {
        if (snapshot.operationPhase !== undefined && TERMINAL_OPERATION_PHASES.has(snapshot.operationPhase)) {
            return true;
        }
        if (failFastOnDegraded && snapshot.healthStatus !== undefined) {
            return UNHEALTHY_STATUSES.has(snapshot.healthStatus);
        }
        return false;
    });
}

export async function waitForApplications(options: WaitOptions): Promise<WaitResult> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const random = options.random ?? Math.random;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const failFastOnDegraded = options.failFastOnDegraded ?? false;
    const deadlineMs = options.timeoutSeconds * 1000;
    const startedAt = now();

    let snapshots: AppSnapshot[] = [];
    let polls = 0;

    for (;;) {
        snapshots = await options.poll();
        polls += 1;
        const elapsedMs = now() - startedAt;
        options.onPoll?.(snapshots, elapsedMs);

        const failure = findTerminalFailure(snapshots, failFastOnDegraded);
        if (failure !== undefined) {
            return {
                outcome: 'failed',
                snapshots,
                reason: describeFailure(failure),
                elapsedMs,
                polls,
            };
        }

        if (snapshots.length > 0 && snapshots.every((s) => areAllConditionsMet(s, options.conditions))) {
            return {
                outcome: 'satisfied',
                snapshots,
                reason: `All ${snapshots.length} application(s) met: ${options.conditions.join(', ')}`,
                elapsedMs,
                polls,
            };
        }

        if (elapsedMs >= deadlineMs) {
            return {
                outcome: 'timedOut',
                snapshots,
                reason: describeTimeout(snapshots, options.conditions, options.timeoutSeconds),
                elapsedMs,
                polls,
            };
        }

        // Jitter spreads fan-out deployments that all poll the same Argo CD instance.
        // Never sleep past the deadline, so the timeout stays honest.
        const jittered = Math.floor(pollIntervalMs * (0.5 + random() * 0.5));
        const remaining = deadlineMs - (now() - startedAt);
        await sleep(Math.max(0, Math.min(jittered, remaining)));
    }
}

function describeFailure(snapshot: AppSnapshot): string {
    if (snapshot.operationPhase !== undefined && TERMINAL_OPERATION_PHASES.has(snapshot.operationPhase)) {
        const detail = snapshot.operationMessage ?? 'no message reported';
        return `Application "${snapshot.name}" operation ${snapshot.operationPhase}: ${detail}`;
    }
    const detail = snapshot.healthMessage ?? 'no message reported';
    return `Application "${snapshot.name}" is ${snapshot.healthStatus ?? 'Unknown'}: ${detail}`;
}

function describeTimeout(
    snapshots: readonly AppSnapshot[],
    conditions: readonly WaitCondition[],
    timeoutSeconds: number,
): string {
    const unmet = snapshots
        .filter((snapshot) => !areAllConditionsMet(snapshot, conditions))
        .map(
            (snapshot) =>
                `${snapshot.name} (sync=${snapshot.syncStatus ?? 'Unknown'}, health=${
                    snapshot.healthStatus ?? 'Unknown'
                }${snapshot.operationPhase === undefined ? '' : `, operation=${snapshot.operationPhase}`})`,
        );
    return `Timed out after ${timeoutSeconds}s waiting for ${conditions.join(', ')}. Still waiting on: ${unmet.join('; ')}`;
}
