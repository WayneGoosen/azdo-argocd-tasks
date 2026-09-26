import { describe, expect, it } from 'vitest';
import { normaliseVersionTag, tagFromReleaseRedirect, versionForCache } from '../src/version';

describe('normaliseVersionTag', () => {
    it.each([
        ['v3.5.3', 'v3.5.3'],
        ['3.5.3', 'v3.5.3'],
        ['  v3.5.3  ', 'v3.5.3'],
        ['V3.5.3', 'v3.5.3'],
    ])('normalises %s', (input, expected) => {
        expect(normaliseVersionTag(input)).toBe(expected);
    });

    it('strips build metadata, which is how servers report their version', () => {
        // A live server reports v3.6.0+b5fc12e; the release tag is v3.6.0.
        expect(normaliseVersionTag('v3.6.0+b5fc12e')).toBe('v3.6.0');
    });

    it('keeps a prerelease suffix, which IS part of the tag', () => {
        expect(normaliseVersionTag('v3.6.0-rc1')).toBe('v3.6.0-rc1');
        expect(normaliseVersionTag('v3.6.0-rc1+abc1234')).toBe('v3.6.0-rc1');
    });

    it.each(['', '   ', 'latest', 'v3.5', 'three.five.three', 'v3.5.3.1'])(
        'rejects %s with an actionable message',
        (input) => {
            expect(() => normaliseVersionTag(input)).toThrow(/valid Argo CD version|No Argo CD CLI version/);
        },
    );
});

describe('versionForCache', () => {
    it('drops the leading v, because tool-lib runs semver.clean on it', () => {
        expect(versionForCache('v3.5.3')).toBe('3.5.3');
        expect(versionForCache('3.5.3')).toBe('3.5.3');
    });
});

describe('tagFromReleaseRedirect', () => {
    it('reads the tag from a releases/latest redirect', () => {
        expect(tagFromReleaseRedirect('https://github.com/argoproj/argo-cd/releases/tag/v3.5.3')).toBe(
            'v3.5.3',
        );
    });

    it('ignores a query string', () => {
        expect(tagFromReleaseRedirect('https://github.com/x/y/releases/tag/v3.4.9?foo=bar')).toBe('v3.4.9');
    });

    it('tolerates a trailing slash', () => {
        expect(tagFromReleaseRedirect('https://github.com/x/y/releases/tag/v3.4.9/')).toBe('v3.4.9');
    });

    it('fails clearly when the redirect carries no tag', () => {
        expect(() => tagFromReleaseRedirect('https://github.com/')).toThrow();
    });
});
