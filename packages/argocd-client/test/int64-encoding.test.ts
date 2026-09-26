// Regression guard for int64 body encoding.
//
// Argo CD's REST gateway marshals with stdlib `encoding/json` (util/grpc/json.go, wired in
// at server/server.go), NOT protojson. Under protojson an int64 must be a JSON string;
// under encoding/json it must be a NUMBER, and a string fails to unmarshal outright.
//
// This bit once already: `rollback` sent `id` as a string, and the e2e replay server --
// which does not type-check -- happily accepted it, so the test encoded the bug rather
// than catching it. This file exists so that every int64 body field is asserted to be a
// number in one obvious place.
//
// Query parameters are deliberately NOT covered: a URL carries strings either way, and
// grpc-gateway parses them from strings regardless.

import { describe, expect, it } from 'vitest';
import { encodeRollbackBody, encodeSyncBody } from '../src/index';

/** Every int64 field this client sends in a request BODY. */
const INT64_BODY_FIELDS: Array<{
    what: string;
    encode: () => string;
    path: string[];
}> = [
    {
        what: 'rollback id',
        encode: () => encodeRollbackBody('app', { id: 5 }, {}),
        path: ['id'],
    },
    {
        what: 'sync retryStrategy.limit',
        encode: () => encodeSyncBody('app', { retryStrategy: { limit: 3 } }, {}),
        path: ['retryStrategy', 'limit'],
    },
];

function valueAt(body: unknown, path: readonly string[]): unknown {
    return path.reduce<unknown>(
        (current, key) => (current as Record<string, unknown> | undefined)?.[key],
        body,
    );
}

describe('int64 body fields are JSON numbers', () => {
    it.each(INT64_BODY_FIELDS)('$what', ({ encode, path }) => {
        const value = valueAt(JSON.parse(encode()), path);
        expect(value, `${path.join('.')} must be present`).toBeDefined();
        expect(typeof value, `${path.join('.')} must be a number, not a ${typeof value}`).toBe('number');
    });

    it('no int64 body field is emitted as a quoted number', () => {
        // A broad net: anything that looks like a stringified integer in a request body is
        // suspicious, because it is almost certainly an int64 that will fail to unmarshal.
        for (const { what, encode } of INT64_BODY_FIELDS) {
            expect(encode(), `${what} contains a quoted number`).not.toMatch(/:\s*"\d+"/);
        }
    });
});
