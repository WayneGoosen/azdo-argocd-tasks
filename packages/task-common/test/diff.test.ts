import { describe, expect, it } from 'vitest';
import { MAX_DIFF_LINES, diffLines, renderUnified, stateToLines } from '../src/diff';

describe('stateToLines', () => {
    it('pretty-prints a JSON-in-a-string state field', () => {
        // Argo CD returns these as strings containing JSON, never as objects.
        expect(stateToLines('{"a":1}')).toEqual(['{', '  "a": 1', '}']);
    });

    it('returns nothing for an absent state, as for a created or deleted resource', () => {
        expect(stateToLines(undefined)).toEqual([]);
        expect(stateToLines('   ')).toEqual([]);
    });

    it('falls back to raw text when the field is not JSON', () => {
        expect(stateToLines('not json\nsecond line')).toEqual(['not json', 'second line']);
    });
});

describe('diffLines', () => {
    it('marks unchanged lines as context', () => {
        expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([
            { kind: ' ', line: 'a' },
            { kind: ' ', line: 'b' },
        ]);
    });

    it('detects an insertion', () => {
        expect(diffLines(['a', 'c'], ['a', 'b', 'c'])).toContainEqual({ kind: '+', line: 'b' });
    });

    it('detects a deletion', () => {
        expect(diffLines(['a', 'b', 'c'], ['a', 'c'])).toContainEqual({ kind: '-', line: 'b' });
    });

    it('handles an empty original', () => {
        expect(diffLines([], ['a'])).toEqual([{ kind: '+', line: 'a' }]);
    });

    it('handles an empty replacement', () => {
        expect(diffLines(['a'], [])).toEqual([{ kind: '-', line: 'a' }]);
    });
});

describe('renderUnified', () => {
    it('counts additions and removals', () => {
        const result = renderUnified(['a', 'b'], ['a', 'c']);
        expect(result.addedLines).toBe(1);
        expect(result.removedLines).toBe(1);
        expect(result.truncated).toBe(false);
    });

    it('prefixes lines the way a diff block expects', () => {
        const result = renderUnified(['old'], ['new']);
        expect(result.text).toContain('-old');
        expect(result.text).toContain('+new');
    });

    it('collapses long unchanged runs', () => {
        const before = Array.from({ length: 40 }, (_, i) => `line${i}`);
        const after = [...before];
        after[20] = 'changed';
        const result = renderUnified(before, after);
        expect(result.text).toContain('@@ ... @@');
        // Only the changed region plus its context survives.
        expect(result.text.split('\n').length).toBeLessThan(20);
    });

    it('refuses to diff pathologically large resources instead of exhausting memory', () => {
        const huge = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line${i}`);
        const result = renderUnified(huge, huge);
        expect(result.truncated).toBe(true);
        expect(result.text).toContain('too large');
    });

    it('produces no diff markers for identical input', () => {
        const result = renderUnified(['a', 'b', 'c'], ['a', 'b', 'c']);
        expect(result.addedLines).toBe(0);
        expect(result.removedLines).toBe(0);
    });
});
