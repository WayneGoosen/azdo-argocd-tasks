import { describe, expect, it } from 'vitest';
import { RevisionHistory } from '@azdo-argocd/argocd-client';
import { selectHistoryId, sortHistory } from '../operations/history';

const HISTORY: RevisionHistory[] = [
    { id: 1, revision: 'aaa', deployedAt: '2026-01-01T00:00:00Z' },
    { id: 3, revision: 'ccc', deployedAt: '2026-01-03T00:00:00Z' },
    { id: 2, revision: 'bbb', deployedAt: '2026-01-02T00:00:00Z' },
];

describe('sortHistory', () => {
    it('orders newest first', () => {
        expect(sortHistory(HISTORY).map((e) => e.id)).toEqual([3, 2, 1]);
    });

    it('handles ids arriving as strings, since they are int64 upstream', () => {
        const mixed: RevisionHistory[] = [{ id: '10' }, { id: 9 }, { id: '11' }];
        expect(sortHistory(mixed).map((e) => String(e.id))).toEqual(['11', '10', '9']);
    });

    it('does not mutate its input', () => {
        const original = [...HISTORY];
        sortHistory(HISTORY);
        expect(HISTORY).toEqual(original);
    });
});

describe('selectHistoryId', () => {
    it('resolves "previous" to the SECOND-NEWEST entry', () => {
        // The dangerous failure mode: getting this backwards would roll production back to
        // its first ever deployment.
        expect(selectHistoryId(HISTORY, 'previous')).toBe(2);
    });

    it('is case-insensitive about "previous"', () => {
        expect(selectHistoryId(HISTORY, 'Previous')).toBe(2);
    });

    it('refuses "previous" when there is only one deployment', () => {
        expect(() => selectHistoryId([{ id: 1 }], 'previous')).toThrow(/at least two deployments/i);
    });

    it('refuses "previous" when there is no history at all', () => {
        expect(() => selectHistoryId([], 'previous')).toThrow(/at least two deployments/i);
    });

    it('accepts an explicit id that exists', () => {
        expect(selectHistoryId(HISTORY, '1')).toBe(1);
    });

    it('rejects an id that does not exist, listing what does', () => {
        expect(() => selectHistoryId(HISTORY, '99')).toThrow(/Available IDs: 3, 2, 1/);
    });

    it('rejects a non-numeric id', () => {
        expect(() => selectHistoryId(HISTORY, 'latest')).toThrow(/not a valid history ID/);
    });

    it('matches an id supplied as a string in the history', () => {
        expect(selectHistoryId([{ id: '7' }, { id: '8' }], '7')).toBe(7);
    });
});
