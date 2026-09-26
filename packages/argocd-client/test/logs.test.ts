import { describe, expect, it } from 'vitest';
import { ArgoCdApiError, formatLogEntries, parseLogStream } from '../src/index';

const CONTEXT = { path: '/api/v1/applications/app/logs' };

function line(payload: unknown): string {
    return JSON.stringify(payload);
}

describe('parseLogStream', () => {
    it('unwraps the result envelope', () => {
        // The payload is under `result`, not at the top level.
        const body = [
            line({ result: { content: 'first', podName: 'p1' } }),
            line({ result: { content: 'second', podName: 'p1' } }),
        ].join('\n');

        const result = parseLogStream(body, CONTEXT);
        expect(result.entries.map((e) => e.content)).toEqual(['first', 'second']);
    });

    it('treats a last:true entry as the terminator', () => {
        const body = [
            line({ result: { content: 'only', podName: 'p1' } }),
            line({ result: { last: true, podName: 'p1' } }),
        ].join('\n');

        const result = parseLogStream(body, CONTEXT);
        expect(result.complete).toBe(true);
        // A contentless terminator is not a log line.
        expect(result.entries).toHaveLength(1);
    });

    it('keeps a terminator that also carries content', () => {
        const body = line({ result: { content: 'final line', last: true } });
        const result = parseLogStream(body, CONTEXT);
        expect(result.complete).toBe(true);
        expect(result.entries.map((e) => e.content)).toEqual(['final line']);
    });

    it('reports an incomplete stream when the terminator never arrives', () => {
        const body = line({ result: { content: 'cut off' } });
        expect(parseLogStream(body, CONTEXT).complete).toBe(false);
    });

    it('throws on an error object arriving mid-stream', () => {
        // The critical case: HTTP status was already 200 before this was known.
        const body = [
            line({ result: { content: 'some output' } }),
            line({ error: { grpc_code: 7, http_code: 403, message: 'permission denied' } }),
        ].join('\n');

        expect(() => parseLogStream(body, CONTEXT)).toThrow(ArgoCdApiError);
    });

    it('names the separate logs RBAC resource on a 403', () => {
        const body = line({ error: { grpc_code: 7, http_code: 403, message: 'permission denied' } });
        expect(() => parseLogStream(body, CONTEXT)).toThrow(/logs" RBAC resource/);
    });

    it('does not add the RBAC hint for a non-403 error', () => {
        const body = line({ error: { grpc_code: 3, http_code: 400, message: 'max pods reached' } });
        expect(() => parseLogStream(body, CONTEXT)).toThrow(/max pods reached/);
        expect(() => parseLogStream(body, CONTEXT)).not.toThrow(/RBAC/);
    });

    it('counts malformed lines instead of failing', () => {
        // A stream cut mid-line leaves a partial JSON fragment.
        const body = [line({ result: { content: 'good' } }), '{"result":{"content":"trunc'].join('\n');
        const result = parseLogStream(body, CONTEXT);
        expect(result.entries).toHaveLength(1);
        expect(result.malformedLines).toBe(1);
    });

    it('ignores blank lines', () => {
        const body = ['', line({ result: { content: 'x' } }), '', ''].join('\n');
        expect(parseLogStream(body, CONTEXT).entries).toHaveLength(1);
    });

    it('returns nothing for an empty stream', () => {
        // Indistinguishable from "no pods matched" server-side, so it must not throw.
        const result = parseLogStream('', CONTEXT);
        expect(result.entries).toEqual([]);
        expect(result.complete).toBe(false);
    });
});

describe('formatLogEntries', () => {
    it('leaves single-pod output unprefixed', () => {
        expect(formatLogEntries([{ content: 'a', podName: 'p1' }, { content: 'b', podName: 'p1' }])).toBe('a\nb');
    });

    it('prefixes the pod name when several pods are interleaved', () => {
        const text = formatLogEntries([
            { content: 'a', podName: 'p1' },
            { content: 'b', podName: 'p2' },
        ]);
        expect(text).toBe('[p1] a\n[p2] b');
    });

    it('tolerates entries with no content', () => {
        expect(formatLogEntries([{ podName: 'p1' }])).toBe('');
    });
});
