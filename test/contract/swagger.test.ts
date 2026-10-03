// Contract test against the vendored Argo CD OpenAPI spec.
//
// This is the guard that replaces generating 261 type definitions to consume a dozen.
// It asserts that every endpoint, query parameter and response field this extension
// depends on still exists, and -- just as importantly -- that the awkward parts of the
// API are still awkward in the way the client assumes:
//
//   * `project` repeated on Get/List but singular on the resource endpoints
//   * `syncOptions` a wrapper object rather than an array
//   * `fields` genuinely absent, so nobody "fixes" the client by adding it back
//   * terminate is DELETE
//
// Pinned to the oldest supported minor (see scripts/fetch-swagger.mjs).

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface SwaggerParameter {
    name: string;
    in: string;
    type?: string;
    items?: { type?: string };
    collectionFormat?: string;
    schema?: { $ref?: string };
}

interface SwaggerOperation {
    operationId?: string;
    parameters?: SwaggerParameter[];
    responses?: Record<string, { schema?: { $ref?: string } }>;
}

interface Swagger {
    paths: Record<string, Record<string, SwaggerOperation>>;
    definitions: Record<string, { properties?: Record<string, { type?: string; $ref?: string; items?: unknown }> }>;
}

const SPEC_PATH = path.join(__dirname, '..', '..', 'vendor', 'swagger', 'argocd.json');
const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')) as Swagger;

function operation(pathKey: string, method: string): SwaggerOperation {
    const entry = spec.paths[pathKey];
    expect(entry, `path ${pathKey} is missing from the spec`).toBeDefined();
    const op = entry?.[method];
    expect(op, `${method.toUpperCase()} ${pathKey} is missing from the spec`).toBeDefined();
    return op as SwaggerOperation;
}

function queryParam(op: SwaggerOperation, name: string): SwaggerParameter | undefined {
    return (op.parameters ?? []).find((p) => p.name === name && p.in === 'query');
}

function definition(name: string): Record<string, unknown> {
    const def = spec.definitions[name];
    expect(def, `definition ${name} is missing from the spec`).toBeDefined();
    return (def?.properties ?? {});
}

describe('endpoints the extension calls', () => {
    it.each([
        ['/api/v1/applications', 'get'],
        ['/api/v1/applications/{name}', 'get'],
        ['/api/v1/applications/{name}/sync', 'post'],
        ['/api/v1/applications/{applicationName}/managed-resources', 'get'],
        ['/api/v1/applications/{applicationName}/resource-tree', 'get'],
        ['/api/v1/applications/{name}/operation', 'delete'],
        ['/api/v1/session/userinfo', 'get'],
        ['/api/version', 'get'],
    ])('%s supports %s', (pathKey, method) => {
        expect(operation(pathKey, method)).toBeDefined();
    });

    it('terminates an operation with DELETE, not POST', () => {
        const entry = spec.paths['/api/v1/applications/{name}/operation'];
        expect(entry?.['delete']).toBeDefined();
        expect(entry?.['post']).toBeUndefined();
    });
});

describe('project parameter shape', () => {
    it('is repeated (array) on Get and List', () => {
        for (const pathKey of ['/api/v1/applications', '/api/v1/applications/{name}']) {
            const param = queryParam(operation(pathKey, 'get'), 'project');
            expect(param?.type, `${pathKey} project should be an array`).toBe('array');
        }
    });

    it('also exposes the legacy repeated "projects" on Get and List', () => {
        for (const pathKey of ['/api/v1/applications', '/api/v1/applications/{name}']) {
            expect(queryParam(operation(pathKey, 'get'), 'projects')?.type).toBe('array');
        }
    });

    it('is a single string on the resource endpoints', () => {
        for (const pathKey of [
            '/api/v1/applications/{applicationName}/managed-resources',
            '/api/v1/applications/{applicationName}/resource-tree',
        ]) {
            const param = queryParam(operation(pathKey, 'get'), 'project');
            expect(param?.type, `${pathKey} project should be a plain string`).toBe('string');
        }
        expect(queryParam(operation('/api/v1/applications/{name}/operation', 'delete'), 'project')?.type).toBe(
            'string',
        );
    });
});

describe('parameters the client relies on', () => {
    it('exposes appNamespace everywhere the extension sends it', () => {
        const paths: Array<[string, string]> = [
            ['/api/v1/applications', 'get'],
            ['/api/v1/applications/{name}', 'get'],
            ['/api/v1/applications/{applicationName}/managed-resources', 'get'],
            ['/api/v1/applications/{applicationName}/resource-tree', 'get'],
            ['/api/v1/applications/{name}/operation', 'delete'],
        ];
        for (const [pathKey, method] of paths) {
            expect(queryParam(operation(pathKey, method), 'appNamespace'), `${pathKey}`).toBeDefined();
        }
    });

    it('exposes refresh and selector on List', () => {
        const op = operation('/api/v1/applications', 'get');
        expect(queryParam(op, 'refresh')).toBeDefined();
        expect(queryParam(op, 'selector')).toBeDefined();
    });

    it('does NOT support a fields parameter', () => {
        // If this ever fails, the app-name picker in the service connection becomes
        // viable again -- see the 2 MB data-source response cap.
        for (const pathKey of ['/api/v1/applications', '/api/v1/applications/{name}']) {
            expect(queryParam(operation(pathKey, 'get'), 'fields')).toBeUndefined();
        }
    });
});

describe('sync request body', () => {
    const syncRequest = definition('applicationApplicationSyncRequest');

    it('carries the fields the client sends', () => {
        for (const field of [
            'revision',
            'prune',
            'dryRun',
            'strategy',
            'resources',
            'syncOptions',
            'retryStrategy',
            'infos',
            'appNamespace',
            'project',
        ]) {
            expect(syncRequest[field], `sync request should have ${field}`).toBeDefined();
        }
    });

    it('takes project as a single string, unlike Get and List', () => {
        expect((syncRequest['project'] as { type?: string }).type).toBe('string');
    });

    it('wraps syncOptions in an object rather than taking a bare array', () => {
        // The whole reason encodeSyncBody exists. A bare array is accepted by the wire
        // format and then silently ignored by the server.
        const syncOptions = syncRequest['syncOptions'] as { $ref?: string; type?: string };
        expect(syncOptions.type).not.toBe('array');
        expect(syncOptions.$ref).toBeDefined();

        const wrapper = definition(syncOptions.$ref!.replace('#/definitions/', ''));
        expect(wrapper['items']).toBeDefined();
        expect((wrapper['items'] as { type?: string }).type).toBe('array');
    });
});

describe('response fields the extension reads', () => {
    it('ResourceDiff exposes the four state fields as strings', () => {
        const diff = definition('v1alpha1ResourceDiff');
        for (const field of ['targetState', 'liveState', 'normalizedLiveState', 'predictedLiveState']) {
            expect((diff[field] as { type?: string })?.type, `${field} should be a JSON string`).toBe('string');
        }
        expect(diff['modified']).toBeDefined();
    });

    it('ApplicationStatus exposes sync, health and operationState', () => {
        const status = definition('v1alpha1ApplicationStatus');
        for (const field of ['sync', 'health', 'operationState', 'resources']) {
            expect(status[field], `ApplicationStatus should have ${field}`).toBeDefined();
        }
    });

    it('ApplicationTree exposes nodes carrying health', () => {
        expect(definition('v1alpha1ApplicationTree')['nodes']).toBeDefined();
        expect(definition('v1alpha1ResourceNode')['health']).toBeDefined();
    });

    it('version response fields are PascalCase', () => {
        const version = definition('versionVersionMessage');
        expect(version['Version']).toBeDefined();
        expect(version['version']).toBeUndefined();
    });

    it('version response carries Platform, which gates the server CLI download', () => {
        // ArgoCDInstall@1 reads this to decide whether the server can serve this agent a
        // binary at all -- the /download route only exists for the server's own os/arch.
        expect(definition('versionVersionMessage')['Platform']).toBeDefined();
    });

    it('userinfo exposes loggedIn for the connection probe', () => {
        expect(definition('sessionGetUserInfoResponse')['loggedIn']).toBeDefined();
    });
});
