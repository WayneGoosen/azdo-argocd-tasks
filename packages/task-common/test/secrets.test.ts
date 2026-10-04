// The secret registry exists because tl.setSecret does NOT protect files we write.
//
// Run summaries and the tab's JSON attachment are produced with fs.writeFileSync and then
// published. The agent masks its own log stream; it has no idea what is inside a file we
// hand it. These tests pin the guard that stands in for that missing masking.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('azure-pipelines-task-lib/task', () => ({ setSecret: vi.fn() }));

import * as tl from 'azure-pipelines-task-lib/task';
import { registerSecret, resetRegisteredSecretsForTesting, secretLeakIn } from '../src/secrets';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcm9qOnBheW1lbnRzOmFkby1jaSJ9.c2lnbmF0dXJl';

describe('registerSecret', () => {
    beforeEach(() => {
        resetRegisteredSecretsForTesting();
        vi.mocked(tl.setSecret).mockClear();
    });

    it('still masks with the agent, as well as recording', () => {
        registerSecret('s3cret');
        expect(tl.setSecret).toHaveBeenCalledWith('s3cret');
    });

    it('ignores empty and undefined rather than registering a value that matches everything', () => {
        // '' is a substring of every string: registering it would make secretLeakIn always fire.
        registerSecret('');
        registerSecret(undefined);
        expect(secretLeakIn('anything at all')).toBeUndefined();
        expect(tl.setSecret).not.toHaveBeenCalled();
    });
});

describe('secretLeakIn', () => {
    beforeEach(() => resetRegisteredSecretsForTesting());

    it('passes content with nothing sensitive in it', () => {
        expect(secretLeakIn('| payments | Synced | Healthy |')).toBeUndefined();
    });

    it('catches a registered secret anywhere in the content', () => {
        registerSecret('super-secret-token');
        expect(secretLeakIn('before super-secret-token after')).toContain('registered as a secret');
    });

    it('catches a secret whose characters JSON escapes', () => {
        // The attachment is checked AFTER JSON.stringify. A secret containing a quote or a
        // backslash appears escaped in that payload, so a raw substring search misses it
        // entirely and the secret is published. This is the exact bypass.
        registerSecret('pa"ss\\word');
        const payload = JSON.stringify({ note: 'token is pa"ss\\word' });
        expect(payload).not.toContain('pa"ss\\word'); // proves the raw form is absent
        expect(secretLeakIn(payload)).toContain('registered as a secret');
    });

    it('catches a JWT that was never registered', () => {
        // The backstop: a token that arrived by some path that did not go through
        // registerSecret -- read back off an object, or from an endpoint nobody audited.
        expect(secretLeakIn(`token: ${JWT}`)).toContain('shaped like a JWT');
    });

    it('does not fire on a token id, which is safe to publish', () => {
        // tokenId is a client-generated UUID and is the whole point of rendering token tables.
        expect(secretLeakIn('| 4f1a2b3c-0000-4aaa-8bbb-ccccdddd0001 | never |')).toBeUndefined();
    });

    it('does not fire on ordinary base64 or a git SHA', () => {
        expect(secretLeakIn('a'.repeat(40))).toBeUndefined();
        expect(secretLeakIn('Y29uZmlnbWFwLWRhdGE=')).toBeUndefined();
    });
});
