import { describe, expect, it } from 'vitest';
import { formatManifest, joinManifests } from '../operations/manifests';

describe('formatManifest', () => {
    it('pretty-prints a JSON-encoded manifest', () => {
        // Manifests arrive as strings containing JSON, never as objects.
        expect(formatManifest('{"kind":"Service"}')).toBe('{\n  "kind": "Service"\n}');
    });

    it('passes through content that is not JSON', () => {
        expect(formatManifest('kind: Service')).toBe('kind: Service');
    });

    it('handles an empty string', () => {
        expect(formatManifest('')).toBe('');
    });
});

describe('joinManifests', () => {
    it('separates documents the way a multi-document file would', () => {
        expect(joinManifests(['{"a":1}', '{"b":2}'])).toBe('{\n  "a": 1\n}\n---\n{\n  "b": 2\n}');
    });

    it('returns an empty string for no manifests', () => {
        expect(joinManifests([])).toBe('');
    });
});
