import { describe, expect, it } from 'vitest';
import {
    ArgoCdApiError,
    ArgoCdClient,
    HttpRequest,
    HttpResponse,
    Transport,
    TransportError,
    buildApplicationQuery,
    buildResourceQuery,
    encodeSyncBody,
    normaliseBaseUrl,
} from '../src/index';

/** Records every request and replays scripted responses. */
function recordingTransport(responses: Array<HttpResponse | Error>): {
    transport: Transport;
    requests: HttpRequest[];
} {
    const requests: HttpRequest[] = [];
    let index = 0;
    const transport: Transport = async (req) => {
        requests.push(req);
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        if (next instanceof Error) {
            throw next;
        }
        return next as HttpResponse;
    };
    return { transport, requests };
}

function ok(body: unknown): HttpResponse {
    return { status: 200, headers: {}, body: JSON.stringify(body) };
}

function client(transport: Transport, overrides = {}): ArgoCdClient {
    return new ArgoCdClient({
        serverUrl: 'https://argocd.example.com',
        token: 'tok',
        transport,
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, random: () => 0, sleep: async () => {} },
        ...overrides,
    });
}

describe('normaliseBaseUrl', () => {
    it.each([
        ['https://argocd.example.com', 'https://argocd.example.com'],
        ['https://argocd.example.com/', 'https://argocd.example.com'],
        ['https://argocd.example.com///', 'https://argocd.example.com'],
        ['https://example.com/argocd', 'https://example.com/argocd'],
        ['  https://example.com/argocd/  ', 'https://example.com/argocd'],
    ])('normalises %s', (input, expected) => {
        expect(normaliseBaseUrl(input)).toBe(expected);
    });

    it('assumes https when no scheme is given', () => {
        expect(normaliseBaseUrl('argocd.example.com')).toBe('https://argocd.example.com');
    });
});

describe('buildApplicationQuery', () => {
    it('never sends project and projects together, because the server ignores projects', () => {
        const params = buildApplicationQuery({ project: 'payments', projects: ['other', 'another'] });
        expect(params.filter((p) => p.key === 'project')).toHaveLength(1);
        expect(params.filter((p) => p.key === 'projects')).toHaveLength(0);
    });

    it('sends projects repeated when no single project is given', () => {
        const params = buildApplicationQuery({ projects: ['a', 'b'] });
        expect(params.filter((p) => p.key === 'projects').map((p) => p.value)).toEqual(['a', 'b']);
    });

    it('omits refresh entirely when not requested', () => {
        // Present-but-empty still triggers a refresh server-side, so absence must be absence.
        expect(buildApplicationQuery({}).some((p) => p.key === 'refresh')).toBe(false);
    });

    it('includes refresh when requested', () => {
        expect(buildApplicationQuery({ refresh: 'hard' })).toContainEqual({ key: 'refresh', value: 'hard' });
    });

    it('drops empty strings rather than sending blank parameters', () => {
        expect(buildApplicationQuery({ appNamespace: '', project: '', selector: '' })).toEqual([]);
    });
});

describe('buildResourceQuery', () => {
    it('emits project as a single value', () => {
        expect(buildResourceQuery({ project: 'payments', appNamespace: 'argocd' })).toEqual([
            { key: 'appNamespace', value: 'argocd' },
            { key: 'project', value: 'payments' },
        ]);
    });
});

describe('encodeSyncBody', () => {
    it('wraps syncOptions in an items object', () => {
        const body = JSON.parse(encodeSyncBody('app', { syncOptions: ['CreateNamespace=true'] }, {}));
        expect(body.syncOptions).toEqual({ items: ['CreateNamespace=true'] });
    });

    it('omits syncOptions entirely when empty', () => {
        expect(JSON.parse(encodeSyncBody('app', { syncOptions: [] }, {}))).not.toHaveProperty('syncOptions');
    });

    it('carries project as a plain string, not an array', () => {
        const body = JSON.parse(encodeSyncBody('app', {}, { project: 'payments' }));
        expect(body.project).toBe('payments');
    });

    it('keeps prune and dryRun false rather than dropping them', () => {
        const body = JSON.parse(encodeSyncBody('app', { prune: false, dryRun: false }, {}));
        expect(body.prune).toBe(false);
        expect(body.dryRun).toBe(false);
    });
});

describe('request construction', () => {
    it('sends the bearer token and JSON content type on writes', async () => {
        const { transport, requests } = recordingTransport([ok({})]);
        await client(transport).syncApplication('app', {}, { project: 'payments' });
        expect(requests[0]?.headers['Authorization']).toBe('Bearer tok');
        expect(requests[0]?.headers['Content-Type']).toBe('application/json');
        expect(requests[0]?.method).toBe('POST');
    });

    it('does not send a content type on reads', async () => {
        const { transport, requests } = recordingTransport([ok({})]);
        await client(transport).getApplication('app');
        expect(requests[0]?.headers['Content-Type']).toBeUndefined();
    });

    it('uses DELETE to terminate an operation', async () => {
        const { transport, requests } = recordingTransport([{ status: 200, headers: {}, body: '' }]);
        await client(transport).terminateOperation('app', { project: 'payments' });
        expect(requests[0]?.method).toBe('DELETE');
        expect(requests[0]?.url).toContain('/operation?');
    });

    it('url-encodes application names', async () => {
        const { transport, requests } = recordingTransport([ok({})]);
        await client(transport).getApplication('team/app');
        expect(requests[0]?.url).toContain('/applications/team%2Fapp');
    });

    it('uses a longer timeout when refreshing, because a refreshing Get blocks', async () => {
        const { transport, requests } = recordingTransport([ok({}), ok({})]);
        const c = client(transport, { timeoutMs: 1000, refreshTimeoutMs: 90_000 });
        await c.getApplication('app');
        await c.getApplication('app', { refresh: 'hard' });
        expect(requests[0]?.timeoutMs).toBe(1000);
        expect(requests[1]?.timeoutMs).toBe(90_000);
    });

    it('preserves a sub-path install', async () => {
        const { transport, requests } = recordingTransport([ok({})]);
        await client(transport, { serverUrl: 'https://example.com/argocd' }).getUserInfo();
        expect(requests[0]?.url).toBe('https://example.com/argocd/api/v1/session/userinfo');
    });

    it('calls /api/version outside /api/v1', async () => {
        const { transport, requests } = recordingTransport([ok({ Version: 'v3.5.3' })]);
        const version = await client(transport).getVersion();
        expect(requests[0]?.url).toBe('https://argocd.example.com/api/version');
        expect(version.Version).toBe('v3.5.3');
    });
});

describe('error mapping', () => {
    it('prefers the error field and exposes the grpc code', async () => {
        const { transport } = recordingTransport([
            { status: 403, headers: {}, body: JSON.stringify({ error: 'permission denied', code: 7 }) },
        ]);
        await expect(client(transport).getApplication('app', { project: 'p' })).rejects.toMatchObject({
            httpStatus: 403,
            grpcCode: 7,
        });
    });

    it('explains the 403-without-project trap', async () => {
        const { transport } = recordingTransport([
            { status: 403, headers: {}, body: JSON.stringify({ error: 'permission denied', code: 7 }) },
        ]);
        await expect(client(transport).getApplication('app')).rejects.toThrow(/Set the "project" input/);
    });

    it('does not show that hint when a project was supplied', async () => {
        const { transport } = recordingTransport([
            { status: 403, headers: {}, body: JSON.stringify({ error: 'permission denied' }) },
        ]);
        await expect(client(transport).getApplication('app', { project: 'p' })).rejects.toThrow(/RBAC policy/);
    });

    it('tolerates an error body with every field omitted', async () => {
        // encoding/json honours omitempty, so code is absent whenever it is 0.
        const { transport } = recordingTransport([{ status: 500, headers: {}, body: '{}' }]);
        const error = await client(transport)
            .getApplication('app', { project: 'p' })
            .catch((e: unknown) => e as ArgoCdApiError);
        expect(error).toBeInstanceOf(ArgoCdApiError);
        expect((error as ArgoCdApiError).grpcCode).toBeUndefined();
        expect((error as ArgoCdApiError).message).toContain('HTTP 500');
    });

    it('tolerates a non-JSON error body', async () => {
        const { transport } = recordingTransport([
            { status: 502, headers: {}, body: '<html>Bad Gateway</html>' },
        ]);
        await expect(
            client(transport, { retry: { maxAttempts: 1 } }).getApplication('app', { project: 'p' }),
        ).rejects.toBeInstanceOf(ArgoCdApiError);
    });
});

describe('retry policy', () => {
    it('retries a read on 503 and returns the eventual success', async () => {
        const { transport, requests } = recordingTransport([
            { status: 503, headers: {}, body: '{}' },
            ok({ metadata: { name: 'app' } }),
        ]);
        const app = await client(transport).getApplication('app', { project: 'p' });
        expect(requests).toHaveLength(2);
        expect(app.metadata?.name).toBe('app');
    });

    it('does NOT retry a write on 503, because the sync may already have started', async () => {
        const { transport, requests } = recordingTransport([{ status: 503, headers: {}, body: '{}' }]);
        await expect(client(transport).syncApplication('app', {}, { project: 'p' })).rejects.toBeInstanceOf(
            ArgoCdApiError,
        );
        expect(requests).toHaveLength(1);
    });

    it('does retry a write on 429, which the server rejected before acting', async () => {
        const { transport, requests } = recordingTransport([
            { status: 429, headers: {}, body: '{}' },
            ok({}),
        ]);
        await client(transport).syncApplication('app', {}, { project: 'p' });
        expect(requests).toHaveLength(2);
    });

    it('retries a write when the connection failed before any response', async () => {
        const { transport, requests } = recordingTransport([
            new TransportError('socket hang up', 'ECONNRESET', false),
            ok({}),
        ]);
        await client(transport).syncApplication('app', {}, { project: 'p' });
        expect(requests).toHaveLength(2);
    });

    it('does NOT retry a write once a response has started', async () => {
        const { transport, requests } = recordingTransport([
            new TransportError('aborted', 'ECONNRESET', true),
        ]);
        await expect(client(transport).syncApplication('app', {}, { project: 'p' })).rejects.toBeInstanceOf(
            TransportError,
        );
        expect(requests).toHaveLength(1);
    });

    it('never exceeds maxAttempts', async () => {
        const { transport, requests } = recordingTransport([{ status: 503, headers: {}, body: '{}' }]);
        await expect(client(transport).getApplication('app', { project: 'p' })).rejects.toBeDefined();
        expect(requests).toHaveLength(3);
    });

    it('does not retry a 404', async () => {
        const { transport, requests } = recordingTransport([{ status: 404, headers: {}, body: '{}' }]);
        await expect(client(transport).getApplication('app', { project: 'p' })).rejects.toBeDefined();
        expect(requests).toHaveLength(1);
    });
});

describe('response parsing', () => {
    it('treats an empty body as an empty object', async () => {
        const { transport } = recordingTransport([{ status: 200, headers: {}, body: '' }]);
        await expect(client(transport).terminateOperation('app')).resolves.toBeUndefined();
    });
});
