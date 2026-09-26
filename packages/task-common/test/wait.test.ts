import { describe, expect, it, vi } from 'vitest';
import { AppSnapshot, areAllConditionsMet, findTerminalFailure, waitForApplications } from '../src/wait';

function app(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
    return { name: 'app', syncStatus: 'Synced', healthStatus: 'Healthy', ...overrides };
}

/** Deterministic clock that advances by a fixed step on every read. */
function fakeClock(stepMs: number): () => number {
    let current = 0;
    return () => {
        const value = current;
        current += stepMs;
        return value;
    };
}

describe('condition evaluation', () => {
    it('requires Synced for sync', () => {
        expect(areAllConditionsMet(app({ syncStatus: 'OutOfSync' }), ['sync'])).toBe(false);
        expect(areAllConditionsMet(app(), ['sync'])).toBe(true);
    });

    it('requires Healthy for health', () => {
        expect(areAllConditionsMet(app({ healthStatus: 'Progressing' }), ['health'])).toBe(false);
        expect(areAllConditionsMet(app(), ['health'])).toBe(true);
    });

    it('treats Suspended as unhealthy unless suspended was requested', () => {
        const suspended = app({ healthStatus: 'Suspended' });
        expect(areAllConditionsMet(suspended, ['health'])).toBe(false);
        expect(areAllConditionsMet(suspended, ['health', 'suspended'])).toBe(true);
    });

    it('treats a finished or absent operation as satisfying operation', () => {
        expect(areAllConditionsMet(app({ operationPhase: undefined }), ['operation'])).toBe(true);
        expect(areAllConditionsMet(app({ operationPhase: 'Succeeded' }), ['operation'])).toBe(true);
        expect(areAllConditionsMet(app({ operationPhase: 'Running' }), ['operation'])).toBe(false);
    });

    it('requires every listed condition', () => {
        expect(areAllConditionsMet(app({ syncStatus: 'OutOfSync' }), ['sync', 'health'])).toBe(false);
    });
});

describe('terminal failures', () => {
    it.each(['Failed', 'Error'] as const)('treats a %s operation as terminal', (phase) => {
        expect(findTerminalFailure([app({ operationPhase: phase })], false)).toBeDefined();
    });

    it('does not treat Degraded as terminal by default', () => {
        // Degraded is transient during a normal rollout; failing fast makes deploys flaky.
        expect(findTerminalFailure([app({ healthStatus: 'Degraded' })], false)).toBeUndefined();
    });

    it('treats Degraded as terminal when fail-fast is requested', () => {
        expect(findTerminalFailure([app({ healthStatus: 'Degraded' })], true)).toBeDefined();
    });

    it('treats a Running operation as not terminal', () => {
        expect(findTerminalFailure([app({ operationPhase: 'Running' })], false)).toBeUndefined();
    });
});

describe('waitForApplications', () => {
    it('returns satisfied on the first poll when already converged', async () => {
        const result = await waitForApplications({
            conditions: ['sync', 'health'],
            timeoutSeconds: 60,
            poll: async () => [app()],
            now: fakeClock(0),
            sleep: async () => {},
        });
        expect(result.outcome).toBe('satisfied');
        expect(result.polls).toBe(1);
    });

    it('polls until the application converges', async () => {
        const states: AppSnapshot[][] = [
            [app({ syncStatus: 'OutOfSync', healthStatus: 'Progressing' })],
            [app({ syncStatus: 'Synced', healthStatus: 'Progressing' })],
            [app()],
        ];
        let index = 0;
        const result = await waitForApplications({
            conditions: ['sync', 'health'],
            timeoutSeconds: 600,
            pollIntervalMs: 10,
            poll: async () => states[Math.min(index++, states.length - 1)] as AppSnapshot[],
            now: fakeClock(1),
            sleep: async () => {},
            random: () => 0.5,
        });
        expect(result.outcome).toBe('satisfied');
        expect(result.polls).toBe(3);
    });

    it('stops immediately on a failed operation without waiting out the timeout', async () => {
        const result = await waitForApplications({
            conditions: ['sync', 'health'],
            timeoutSeconds: 3600,
            poll: async () => [app({ operationPhase: 'Failed', operationMessage: 'one or more objects failed' })],
            now: fakeClock(0),
            sleep: async () => {},
        });
        expect(result.outcome).toBe('failed');
        expect(result.polls).toBe(1);
        expect(result.reason).toContain('one or more objects failed');
    });

    it('times out and names the applications still not ready', async () => {
        const result = await waitForApplications({
            conditions: ['sync', 'health'],
            timeoutSeconds: 1,
            pollIntervalMs: 500,
            poll: async () => [
                app({ name: 'ready' }),
                app({ name: 'stuck', syncStatus: 'OutOfSync', healthStatus: 'Progressing' }),
            ],
            now: fakeClock(900),
            sleep: async () => {},
            random: () => 0.5,
        });
        expect(result.outcome).toBe('timedOut');
        expect(result.reason).toContain('stuck');
        expect(result.reason).not.toContain('ready (');
    });

    it('requires every application to converge, not just one', async () => {
        const result = await waitForApplications({
            conditions: ['sync'],
            timeoutSeconds: 1,
            pollIntervalMs: 100,
            poll: async () => [app({ name: 'a' }), app({ name: 'b', syncStatus: 'OutOfSync' })],
            now: fakeClock(600),
            sleep: async () => {},
            random: () => 0,
        });
        expect(result.outcome).toBe('timedOut');
    });

    it('never sleeps past the deadline', async () => {
        const sleeps: number[] = [];
        await waitForApplications({
            conditions: ['sync'],
            timeoutSeconds: 1,
            pollIntervalMs: 10_000,
            poll: async () => [app({ syncStatus: 'OutOfSync' })],
            now: fakeClock(400),
            sleep: async (ms) => {
                sleeps.push(ms);
            },
            random: () => 1,
        });
        expect(Math.max(...sleeps)).toBeLessThanOrEqual(1000);
        expect(sleeps.every((ms) => ms >= 0)).toBe(true);
    });

    it('jitters the poll interval to spread concurrent pipelines', async () => {
        const sleeps: number[] = [];
        const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(0.5);
        let polls = 0;
        await waitForApplications({
            conditions: ['sync'],
            timeoutSeconds: 600,
            pollIntervalMs: 1000,
            poll: async () => {
                polls += 1;
                return [app({ syncStatus: polls >= 3 ? 'Synced' : 'OutOfSync' })];
            },
            now: fakeClock(1),
            sleep: async (ms) => {
                sleeps.push(ms);
            },
            random,
        });
        // Full-jitter band is [0.5x, 1.0x] of the interval.
        expect(sleeps[0]).toBe(500);
        expect(sleeps[1]).toBe(1000);
    });

    it('reports progress through the onPoll hook', async () => {
        const seen: number[] = [];
        await waitForApplications({
            conditions: ['sync'],
            timeoutSeconds: 60,
            poll: async () => [app()],
            now: fakeClock(0),
            sleep: async () => {},
            onPoll: (snapshots) => seen.push(snapshots.length),
        });
        expect(seen).toEqual([1]);
    });
});
