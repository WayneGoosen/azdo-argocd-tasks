// Multi-source applications report their revision in a different field.
//
// Argo CD fills `revision` for a single-source app and `revisions` for a multi-source one,
// leaving the other empty -- on status.sync, on operationState.syncResult and on every
// history entry. Reading only the singular meant every multi-source application published
// an empty `revision` output and a blank column in the run summary, with no warning and
// nothing in the log to explain it. Reported from a real pipeline before this was caught.

import { describe, expect, it } from 'vitest';
import { revisionOf, revisionsOf } from '../src/types';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('revisionOf', () => {
    it('reads a single-source revision', () => {
        expect(revisionOf({ revision: SHA_A })).toBe(SHA_A);
    });

    it('reads a multi-source revision, where the singular field is absent', () => {
        expect(revisionOf({ revisions: [SHA_A, SHA_B] })).toBe(`${SHA_A},${SHA_B}`);
    });

    it('treats an empty singular field as absent rather than preferring it', () => {
        // This is the actual shape Argo CD returns for a multi-source app: the singular
        // field is present and empty, not missing, so `?? ` on it never falls through.
        expect(revisionOf({ revision: '', revisions: [SHA_A] })).toBe(SHA_A);
    });

    it('prefers the plural when both are populated', () => {
        // The singular can only hold one of several, so preferring it would drop the rest.
        expect(revisionOf({ revision: SHA_A, revisions: [SHA_A, SHA_B] })).toBe(`${SHA_A},${SHA_B}`);
    });

    it('returns undefined when there is nothing to report', () => {
        expect(revisionOf(undefined)).toBeUndefined();
        expect(revisionOf({})).toBeUndefined();
        expect(revisionOf({ revision: '', revisions: [] })).toBeUndefined();
        expect(revisionOf({ revisions: ['', ''] })).toBeUndefined();
    });

    it('handles a Helm chart plus a values repo, the common two-source shape', () => {
        // The chart source reports a CHART VERSION, not a SHA -- so the joined string mixes
        // kinds and callers who need one of them have to use the list.
        const value = { revision: '', revisions: ['1.2.3', SHA_B] };
        expect(revisionOf(value)).toBe(`1.2.3,${SHA_B}`);
        expect(revisionsOf(value)).toEqual(['1.2.3', SHA_B]);
    });
});

describe('revisionsOf', () => {
    it('gives a single-source app a one-entry list', () => {
        expect(revisionsOf({ revision: SHA_A })).toEqual([SHA_A]);
    });

    it('preserves source order', () => {
        expect(revisionsOf({ revisions: [SHA_B, SHA_A] })).toEqual([SHA_B, SHA_A]);
    });

    it('is empty rather than undefined when there is nothing', () => {
        expect(revisionsOf(undefined)).toEqual([]);
        expect(revisionsOf({ revision: '', revisions: [] })).toEqual([]);
    });
});
