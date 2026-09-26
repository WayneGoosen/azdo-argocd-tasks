import { describe, expect, it } from 'vitest';
import { aggregate, decideFromDiff, decideFromStatus, decideFromWait } from '../src/result';
import { WaitResult } from '../src/wait';

function waitResult(outcome: WaitResult['outcome']): WaitResult {
    return { outcome, snapshots: [], reason: 'reason', elapsedMs: 1, polls: 1 };
}

describe('decideFromWait', () => {
    it('succeeds when the conditions were met', () => {
        expect(decideFromWait(waitResult('satisfied'), { failOnTimeout: true }).verdict).toBe('succeeded');
    });

    it('fails on a terminal failure regardless of the timeout policy', () => {
        expect(decideFromWait(waitResult('failed'), { failOnTimeout: false }).verdict).toBe('failed');
    });

    it('fails on timeout when failOnTimeout is set', () => {
        expect(decideFromWait(waitResult('timedOut'), { failOnTimeout: true }).verdict).toBe('failed');
    });

    it('downgrades a timeout to succeeded-with-issues when failOnTimeout is off', () => {
        expect(decideFromWait(waitResult('timedOut'), { failOnTimeout: false }).verdict).toBe(
            'succeededWithIssues',
        );
    });
});

describe('decideFromStatus', () => {
    const policy = { failOnOutOfSync: false, failOnHealth: ['Degraded', 'Missing'] };

    it('succeeds when everything is synced and healthy', () => {
        expect(
            decideFromStatus([{ name: 'a', syncStatus: 'Synced', healthStatus: 'Healthy' }], policy).verdict,
        ).toBe('succeeded');
    });

    it.each(['Degraded', 'Missing'])('fails on %s health', (health) => {
        expect(decideFromStatus([{ name: 'a', syncStatus: 'Synced', healthStatus: health }], policy).verdict).toBe(
            'failed',
        );
    });

    it('does not fail on a health status outside the configured list', () => {
        expect(
            decideFromStatus([{ name: 'a', syncStatus: 'Synced', healthStatus: 'Progressing' }], policy).verdict,
        ).toBe('succeeded');
    });

    it('reports out-of-sync as an issue by default', () => {
        expect(
            decideFromStatus([{ name: 'a', syncStatus: 'OutOfSync', healthStatus: 'Healthy' }], policy).verdict,
        ).toBe('succeededWithIssues');
    });

    it('fails out-of-sync when asked to', () => {
        expect(
            decideFromStatus([{ name: 'a', syncStatus: 'OutOfSync', healthStatus: 'Healthy' }], {
                ...policy,
                failOnOutOfSync: true,
            }).verdict,
        ).toBe('failed');
    });

    it('prefers the health failure over the sync issue', () => {
        const decision = decideFromStatus(
            [{ name: 'a', syncStatus: 'OutOfSync', healthStatus: 'Degraded' }],
            policy,
        );
        expect(decision.verdict).toBe('failed');
        expect(decision.message).toContain('Degraded');
    });
});

describe('decideFromDiff', () => {
    it('succeeds with no differences', () => {
        expect(decideFromDiff(0, true).verdict).toBe('succeeded');
    });

    it('reports differences as an issue by default', () => {
        expect(decideFromDiff(3, false).verdict).toBe('succeededWithIssues');
    });

    it('fails on differences when used as a gate', () => {
        expect(decideFromDiff(3, true).verdict).toBe('failed');
    });
});

describe('aggregate', () => {
    it('fails if any application failed', () => {
        expect(
            aggregate([
                { verdict: 'succeeded', message: 'a' },
                { verdict: 'failed', message: 'b' },
                { verdict: 'succeededWithIssues', message: 'c' },
            ]).verdict,
        ).toBe('failed');
    });

    it('reports issues when nothing failed but something had issues', () => {
        expect(
            aggregate([
                { verdict: 'succeeded', message: 'a' },
                { verdict: 'succeededWithIssues', message: 'b' },
            ]).verdict,
        ).toBe('succeededWithIssues');
    });

    it('succeeds when everything succeeded', () => {
        expect(aggregate([{ verdict: 'succeeded', message: 'a' }]).verdict).toBe('succeeded');
    });
});
