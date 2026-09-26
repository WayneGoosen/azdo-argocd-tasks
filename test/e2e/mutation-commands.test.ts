// End-to-end tests for the Phase 2b mutating commands, against the shipped bundle.
//
// The two properties worth proving here are the ones that would be expensive to get wrong:
//   * `set` sends back a spec that still contains fields the client never modelled --
//     because PUT /spec is a full replace and anything missing would be deleted.
//   * every `delete` guard actually refuses, and refuses BEFORE any request is made.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureBuilt, outputVariable, runTask } from '../support/run-task';

const TOKEN = 'mutation-token';

interface Scenario {
    application?: unknown;
    createStatus?: number;
    createBody?: unknown;
}

let server: http.Server;
let baseUrl: string;
let scenario: Scenario = {};
let requests: Array<{ method: string; url: string; body: string }> = [];
let workDir: string;

/** A spec with plenty of fields the narrow client types do not model. */
function richApplication(): unknown {
    return {
        metadata: { name: 'payments', namespace: 'argocd' },
        spec: {
            project: 'payments',
            source: {
                repoURL: 'https://example.com/gitops',
                path: 'apps/payments',
                targetRevision: 'HEAD',
                helm: { valueFiles: ['values.yaml'], parameters: [{ name: 'image.tag', value: '1.0.0' }] },
                plugin: { name: 'custom-plugin' },
            },
            destination: { server: 'https://kubernetes.default.svc', namespace: 'payments' },
            ignoreDifferences: [{ group: 'apps', kind: 'Deployment', jsonPointers: ['/spec/replicas'] }],
            info: [{ name: 'owner', value: 'payments-team' }],
            revisionHistoryLimit: 20,
        },
        status: { sync: { status: 'Synced' }, health: { status: 'Healthy' } },
    };
}

beforeAll(async () => {
    ensureBuilt();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argocd-manifests-'));

    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const url = req.url ?? '';
            const method = req.method ?? '';
            requests.push({ method, url, body: Buffer.concat(chunks).toString('utf8') });

            const json = (status: number, payload: unknown): void => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
            };

            if (method === 'POST' && url.startsWith('/api/v1/applications')) {
                json(scenario.createStatus ?? 200, scenario.createBody ?? richApplication());
            } else if (method === 'PUT' && url.includes('/spec')) {
                // Echo the spec back, as the real server does after normalizing.
                json(200, JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } else if (method === 'DELETE') {
                json(200, {});
            } else if (url.includes('/resource-tree')) {
                json(200, { nodes: [] });
            } else if (url.includes('/api/v1/applications/')) {
                json(200, scenario.application ?? richApplication());
            } else {
                json(404, { error: 'not found', code: 5 });
            }
        });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function run(inputs: Record<string, string>): Promise<{ stdout: string; exitCode: number }> {
    requests = [];
    return runTask({
        task: 'ArgoCDAppV1',
        inputs: { project: 'payments', publishSummary: 'false', ...inputs },
        endpoint: { url: baseUrl, token: TOKEN },
    });
}

function writeManifest(name: string, content: string): string {
    const file = path.join(workDir, name);
    fs.writeFileSync(file, content);
    return file;
}

describe('create', () => {
    it('creates from a YAML manifest', async () => {
        scenario = {};
        const file = writeManifest(
            'app.yaml',
            `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payments
spec:
  project: payments
  source:
    repoURL: https://example.com/gitops
    path: apps/payments
`,
        );

        const { stdout } = await run({ command: 'create', manifestFile: file });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(outputVariable(stdout, 'appName')).toBe('payments');
        expect(outputVariable(stdout, 'createdCount')).toBe('1');

        const post = requests.find((r) => r.method === 'POST');
        expect(JSON.parse(post!.body)).toMatchObject({ kind: 'Application' });
    });

    it('creates every document of a multi-document YAML file', async () => {
        scenario = {};
        const file = writeManifest(
            'apps.yaml',
            `kind: Application
metadata: { name: one }
---
kind: Application
metadata: { name: two }
`,
        );

        const { stdout } = await run({ command: 'create', manifestFile: file });
        expect(outputVariable(stdout, 'createdCount')).toBe('2');
        expect(requests.filter((r) => r.method === 'POST')).toHaveLength(2);
    });

    it('accepts JSON as well as YAML', async () => {
        scenario = {};
        const file = writeManifest(
            'app.json',
            JSON.stringify({ kind: 'Application', metadata: { name: 'payments' } }),
        );
        const { stdout } = await run({ command: 'create', manifestFile: file });
        expect(stdout).toContain('##vso[task.complete result=Succeeded');
    });

    it('sends upsert as a query parameter, not a body field', async () => {
        scenario = {};
        const file = writeManifest('u.yaml', 'kind: Application\nmetadata: { name: payments }\n');
        await run({ command: 'create', manifestFile: file, upsert: 'true' });

        const post = requests.find((r) => r.method === 'POST');
        expect(post?.url).toContain('upsert=true');
        expect(JSON.parse(post!.body)).not.toHaveProperty('upsert');
    });

    it('rejects a manifest that is not an Application', async () => {
        scenario = {};
        const file = writeManifest('cm.yaml', 'kind: ConfigMap\nmetadata: { name: x }\n');
        const { stdout } = await run({ command: 'create', manifestFile: file });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('not "Application"');
    });

    it('rejects an unparseable manifest', async () => {
        scenario = {};
        const file = writeManifest('bad.yaml', 'kind: Application\n  bad indent: [');
        const { stdout } = await run({ command: 'create', manifestFile: file });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('Could not parse');
    });
});

describe('set', () => {
    it('preserves spec fields the client does not model', async () => {
        // The property that matters: PUT /spec is a full replace, so anything dropped here
        // would be deleted on the server.
        scenario = {};
        const { stdout } = await run({
            command: 'set',
            applications: 'payments',
            helmParameters: 'image.tag=2.0.0',
        });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        const put = requests.find((r) => r.method === 'PUT');
        expect(put).toBeDefined();

        const spec = JSON.parse(put!.body) as Record<string, any>;
        expect(spec.ignoreDifferences).toEqual([
            { group: 'apps', kind: 'Deployment', jsonPointers: ['/spec/replicas'] },
        ]);
        expect(spec.info).toEqual([{ name: 'owner', value: 'payments-team' }]);
        expect(spec.revisionHistoryLimit).toBe(20);
        expect(spec.source.plugin).toEqual({ name: 'custom-plugin' });
        // And the actual change landed.
        expect(spec.source.helm.parameters).toEqual([{ name: 'image.tag', value: '2.0.0' }]);
    });

    it('replaces the whole value-file list rather than appending', async () => {
        scenario = {};
        await run({ command: 'set', applications: 'payments', helmValueFiles: 'prod.yaml\nsecrets.yaml' });
        const spec = JSON.parse(requests.find((r) => r.method === 'PUT')!.body) as Record<string, any>;
        expect(spec.source.helm.valueFiles).toEqual(['prod.yaml', 'secrets.yaml']);
    });

    it('merges a kustomize image by name', async () => {
        scenario = {};
        await run({ command: 'set', applications: 'payments', kustomizeImages: 'nginx:1.3' });
        const spec = JSON.parse(requests.find((r) => r.method === 'PUT')!.body) as Record<string, any>;
        expect(spec.source.kustomize.images).toEqual(['nginx:1.3']);
    });

    it('warns about drifting from Git', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'set', applications: 'payments', targetRevision: 'v2' });
        expect(stdout).toContain('##vso[task.issue type=warning;');
        expect(stdout).toContain('ahead of Git');
        expect(stdout).toContain('GitOps repository');
    });

    it('requires at least one field to change', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'set', applications: 'payments' });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('at least one field');
    });
});

describe('unset', () => {
    it('removes a helm parameter by name', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'unset', applications: 'payments', helmParameters: 'image.tag' });

        expect(stdout).toContain('removed helm parameter image.tag');
        const spec = JSON.parse(requests.find((r) => r.method === 'PUT')!.body) as Record<string, any>;
        expect(spec.source.helm.parameters).toEqual([]);
    });

    it('rejects a name=value line, naming the fix', async () => {
        scenario = {};
        const { stdout } = await run({
            command: 'unset',
            applications: 'payments',
            helmParameters: 'image.tag=2.0.0',
        });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('names only');
        expect(stdout).toContain('"image.tag"');
    });

    it('reports when there was nothing to remove', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'unset', applications: 'payments', helmParameters: 'nope' });
        expect(stdout).toContain('was not set');
    });
});

describe('delete guards', () => {
    it('refuses without confirmation, before making any request', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'delete', applications: 'payments' });

        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('without confirmation');
        expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    });

    it('refuses a label selector outright', async () => {
        scenario = {};
        const { stdout } = await run({
            command: 'delete',
            selector: 'app.kubernetes.io/instance=platform',
            confirm: 'true',
        });

        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('does not accept a label selector');
        expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    });

    it('refuses cascade=false combined with a propagation policy', async () => {
        scenario = {};
        const { stdout } = await run({
            command: 'delete',
            applications: 'payments',
            confirm: 'true',
            cascade: 'false',
            propagationPolicy: 'foreground',
        });

        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('cannot be combined with cascade disabled');
        expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    });

    it('deletes when confirmed, and says the deletion is asynchronous', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'delete', applications: 'payments', confirm: 'true' });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(stdout).toContain('asynchronously');
        expect(outputVariable(stdout, 'deletedCount')).toBe('1');

        const del = requests.find((r) => r.method === 'DELETE');
        expect(del?.url).toContain('/api/v1/applications/payments');
    });

    it('never sends a propagation policy alongside cascade=false', async () => {
        scenario = {};
        await run({ command: 'delete', applications: 'payments', confirm: 'true', cascade: 'false' });
        const del = requests.find((r) => r.method === 'DELETE');
        expect(del?.url).toContain('cascade=false');
        expect(del?.url).not.toContain('propagationPolicy');
    });

    it('passes a propagation policy when cascading', async () => {
        scenario = {};
        await run({
            command: 'delete',
            applications: 'payments',
            confirm: 'true',
            propagationPolicy: 'background',
        });
        expect(requests.find((r) => r.method === 'DELETE')?.url).toContain('propagationPolicy=background');
    });
});
