import { describe, expect, it } from 'vitest';
import {
    ArgoCdApiError,
    ArgoCdClient,
    HttpRequest,
    HttpResponse,
    Transport,
    buildResourceRefQuery,
    encodeRollbackBody,
    encodeRunActionBody,
    explainRollbackFailure,
} from '../src/index';

function recording(responses: Array<HttpResponse | Error>): { transport: Transport; requests: HttpRequest[] } {
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

function client(transport: Transport): ArgoCdClient {
    return new ArgoCdClient({
        serverUrl: 'https://argocd.example.com',
        token: 'tok',
        transport,
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, random: () => 0, sleep: async () => {} },
    });
}

const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });

describe('encodeRollbackBody', () => {
    it('sends id as a NUMBER, not a string', () => {
        // Argo CD's gateway marshals with stdlib encoding/json, so an int64 field is a
        // JSON number; a string fails to unmarshal. This assertion previously demanded
        // the string form and the mock server happily accepted it -- the test encoded
        // the bug.
        const body = JSON.parse(encodeRollbackBody('app', { id: 5 }, {}));
        expect(body.id).toBe(5);
        expect(typeof body.id).toBe('number');
    });

    it('carries project and appNamespace in the body, not the query', () => {
        const body = JSON.parse(encodeRollbackBody('app', { id: 1 }, { project: 'p', appNamespace: 'ns' }));
        expect(body.project).toBe('p');
        expect(body.appNamespace).toBe('ns');
    });

    it('keeps prune and dryRun false rather than dropping them', () => {
        const body = JSON.parse(encodeRollbackBody('app', { id: 1, prune: false, dryRun: false }, {}));
        expect(body.prune).toBe(false);
        expect(body.dryRun).toBe(false);
    });
});

describe('encodeRunActionBody', () => {
    it('puts everything in the body, since the endpoint takes no query params', () => {
        const body = JSON.parse(
            encodeRunActionBody(
                'app',
                { action: 'restart', resource: { group: 'apps', kind: 'Deployment', name: 'api', namespace: 'prod' } },
                { project: 'p' },
            ),
        );
        expect(body).toMatchObject({
            name: 'app',
            action: 'restart',
            kind: 'Deployment',
            resourceName: 'api',
            group: 'apps',
            namespace: 'prod',
            project: 'p',
        });
    });

    it('sends parameters as name/value strings', () => {
        const body = JSON.parse(
            encodeRunActionBody(
                'app',
                {
                    action: 'scale',
                    parameters: [{ name: 'replicas', value: '3' }],
                    resource: { kind: 'Deployment', name: 'api' },
                },
                {},
            ),
        );
        expect(body.resourceActionParameters).toEqual([{ name: 'replicas', value: '3' }]);
    });

    it('omits parameters entirely when there are none', () => {
        const body = JSON.parse(
            encodeRunActionBody('app', { action: 'restart', resource: { kind: 'Deployment', name: 'api' } }, {}),
        );
        expect(body).not.toHaveProperty('resourceActionParameters');
    });
});

describe('buildResourceRefQuery', () => {
    it('always sends kind and resourceName', () => {
        expect(buildResourceRefQuery({ kind: 'Pod', name: 'p1' })).toEqual([
            { key: 'kind', value: 'Pod' },
            { key: 'resourceName', value: 'p1' },
        ]);
    });

    it('adds group and namespace when present', () => {
        const params = buildResourceRefQuery({ group: 'apps', kind: 'Deployment', name: 'api', namespace: 'prod' });
        expect(params).toContainEqual({ key: 'group', value: 'apps' });
        expect(params).toContainEqual({ key: 'namespace', value: 'prod' });
    });
});

describe('explainRollbackFailure', () => {
    const autoSyncError = new ArgoCdApiError({
        message: 'rollback cannot be initiated when auto-sync is enabled',
        httpStatus: 400,
        method: 'POST',
        path: '/rollback',
    });

    it('explains the auto-sync rejection', () => {
        const explained = explainRollbackFailure(autoSyncError) as ArgoCdApiError;
        expect(explained.hint).toMatch(/automated sync/);
        expect(explained.hint).toMatch(/roll back in Git/);
    });

    it('leaves unrelated errors untouched', () => {
        const other = new ArgoCdApiError({ message: 'boom', httpStatus: 500, method: 'POST', path: '/rollback' });
        expect(explainRollbackFailure(other)).toBe(other);
    });

    it('passes through non-API errors', () => {
        const plain = new Error('socket hang up');
        expect(explainRollbackFailure(plain)).toBe(plain);
    });
});

describe('client Phase 2 requests', () => {
    it('uses the v2 action endpoint', async () => {
        const { transport, requests } = recording([ok({})]);
        await client(transport).runResourceAction(
            'app',
            { action: 'restart', resource: { kind: 'Deployment', name: 'api' } },
            { project: 'p' },
        );
        expect(requests[0]?.url).toContain('/resource/actions/v2');
        expect(requests[0]?.method).toBe('POST');
    });

    it('explains a 404 from the v2 action endpoint as an unsupported server', async () => {
        const { transport } = recording([{ status: 404, headers: {}, body: '{"code":5}' }]);
        await expect(
            client(transport).runResourceAction(
                'app',
                { action: 'restart', resource: { kind: 'Deployment', name: 'api' } },
                { project: 'p' },
            ),
        ).rejects.toThrow(/added in Argo CD 3\.1/);
    });

    it('forces follow=false on logs, so the stream always terminates', async () => {
        const { transport, requests } = recording([{ status: 200, headers: {}, body: '' }]);
        await client(transport).getPodLogs('app', {}, { project: 'p' });
        expect(requests[0]?.url).toContain('follow=false');
    });

    it('sends tailLines and sinceSeconds as strings, and skips zero', async () => {
        const { transport, requests } = recording([{ status: 200, headers: {}, body: '' }]);
        await client(transport).getPodLogs('app', { tailLines: 50, sinceSeconds: 0 }, {});
        expect(requests[0]?.url).toContain('tailLines=50');
        expect(requests[0]?.url).not.toContain('sinceSeconds');
    });

    it('never sends both podName and a resource filter', async () => {
        const { transport, requests } = recording([{ status: 200, headers: {}, body: '' }]);
        await client(transport).getPodLogs(
            'app',
            { podName: 'p1', resource: { kind: 'Deployment', name: 'api' } },
            {},
        );
        expect(requests[0]?.url).toContain('podName=p1');
        expect(requests[0]?.url).not.toContain('kind=Deployment');
    });

    it('requests manifests with a revision', async () => {
        const { transport, requests } = recording([ok({ manifests: [] })]);
        await client(transport).getManifests('app', { revision: 'abc123' }, { project: 'p' });
        expect(requests[0]?.url).toContain('/manifests?');
        expect(requests[0]?.url).toContain('revision=abc123');
    });
});
