import { describe, expect, it } from 'vitest';
import { describeDurationSeconds, describeExpiry, parseDurationSeconds } from '../src/duration';

describe('parseDurationSeconds', () => {
    it.each([
        ['30s', 30],
        ['5m', 300],
        ['12h', 43200],
        ['90d', 7776000],
        ['2w', 1209600],
    ])('parses %s', (input, expected) => {
        expect(parseDurationSeconds(input)).toBe(expected);
    });

    it('treats a bare number as seconds, matching the API unit', () => {
        expect(parseDurationSeconds('3600')).toBe(3600);
    });

    it('is case-insensitive and tolerates whitespace', () => {
        expect(parseDurationSeconds('  90D ')).toBe(7776000);
    });

    it('accepts zero, which the API reads as never expiring', () => {
        expect(parseDurationSeconds('0')).toBe(0);
    });

    it.each(['', '   ', '90 days', 'forever', '90y', '-5d', '1.5d', 'd90'])(
        'rejects %s rather than defaulting',
        (input) => {
            // A lenient parser returning 0 here would silently mint a PERMANENT token from
            // a typo, because expiresIn: 0 means "never expires".
            expect(() => parseDurationSeconds(input)).toThrow();
        },
    );

    it('names the accepted units when it rejects', () => {
        expect(() => parseDurationSeconds('90y')).toThrow(/s \(seconds\), m \(minutes\)/);
    });
});

describe('describeDurationSeconds', () => {
    it.each([
        [0, 'never expires'],
        [7776000, '90 days'],
        [86400, '1 day'],
        [43200, '12 hours'],
        [1209600, '2 weeks'],
        [90, '90 seconds'],
    ])('describes %s as %s', (seconds, expected) => {
        expect(describeDurationSeconds(seconds)).toBe(expected);
    });
});

describe('describeExpiry', () => {
    it('reports never for zero or missing', () => {
        expect(describeExpiry(0)).toBe('never');
        expect(describeExpiry(undefined)).toBe('never');
    });

    it('formats a unix timestamp as ISO 8601', () => {
        expect(describeExpiry(1767225600)).toBe('2026-01-01T00:00:00.000Z');
    });
});
