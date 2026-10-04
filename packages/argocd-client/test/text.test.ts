// trimSlashes replaced `replace(/\/+$/, '')` in six places.
//
// That regex is polynomial: `/+` is greedy with no possessive form, so when `$` fails the
// engine retries the run from each later position. The behavioural cases below are the
// contract; the timing case is the reason the function exists at all.

import { describe, expect, it } from 'vitest';
import { trimSlashes } from '../src/text';

describe('trimSlashes', () => {
    it('strips trailing slashes by default', () => {
        expect(trimSlashes('https://argocd.example.com/')).toBe('https://argocd.example.com');
        expect(trimSlashes('https://argocd.example.com///')).toBe('https://argocd.example.com');
        expect(trimSlashes('https://argocd.example.com')).toBe('https://argocd.example.com');
    });

    it('leaves interior and leading slashes alone', () => {
        expect(trimSlashes('https://example.com/argocd/')).toBe('https://example.com/argocd');
        expect(trimSlashes('/argocd')).toBe('/argocd');
    });

    it('strips both ends when asked, preserving interior slashes', () => {
        // This is the multi-segment subresource case: the slashes INSIDE must survive.
        expect(trimSlashes('/apps/Deployment/restart/', 'both')).toBe('apps/Deployment/restart');
    });

    it('handles strings that are entirely slashes, and empties', () => {
        expect(trimSlashes('///')).toBe('');
        expect(trimSlashes('///', 'both')).toBe('');
        expect(trimSlashes('')).toBe('');
        expect(trimSlashes('', 'both')).toBe('');
    });

    it('is linear, not quadratic', () => {
        // The regex it replaced took ~2.6s for 80k slashes and grew with the square of the
        // input. A generous ceiling: the point is to catch a reintroduced backtracking
        // implementation, not to benchmark the machine.
        const pathological = '/'.repeat(200_000) + 'x';
        const started = Date.now();
        expect(trimSlashes(pathological)).toBe(pathological);
        expect(Date.now() - started, 'trimSlashes appears to backtrack').toBeLessThan(250);
    });
});
