// End-to-end tests for ArgoCDAppSet against the shipped bundle.
//
// The headline assertion is the BODY SHAPE ASYMMETRY between the two POSTs: create sends a
// bare ApplicationSet with flags in the query, generate sends it wrapped as
// {"applicationSet": ...}. Getting either backwards produces a request the server rejects
// or, worse, quietly misreads.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureBuilt, outputVariable, runTask } from '../support/run-task';

interface Scenario {
    appsets?: unknown[];
    generated?: unknown[];
    preserveResources?: boolean;
    ownedResources?: number;
    generateStatus?: number;
    generateBody?: unknown;
}

let server: http.Server;
let baseUrl: string;
let scenario: Scenario = {};
let requests: Array<{ method: string; url: string; body: string }> = [];
let workDir: string;

function applicationSet(name: string): unknown {
    return {
        metadata: { name, namespace: 'argocd' },
        spec: {
            generators: [{ list: { elements: [{ cluster: 'in-cluster' }] } }],
            template: { metadata: { name: `${name}-{{cluster}}` } },
            ...(scenario.preserveResources === true
                ? { syncPolicy: { preserveResourcesOnDeletion: true } }
                : {}),
        },
        status: {
            resources: Array.from({ length: scenario.ownedResources ?? 2 }, (_, i) => ({
                name: `${name}-app-${i}`,
            })),
        },
    };
}

function application(name: string): unknown {
    return {
        metadata: { name },
        spec: {
            project: 'payments',
            destination: { server: 'https://kubernetes.default.svc', namespace: 'payments' },
        },
    };
}

beforeAll(async () => {
    ensureBuilt();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argocd-appset-'));

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

            if (method === 'POST' && url.includes('/applicationsets/generate')) {
                json(scenario.generateStatus ?? 200, scenario.generateBody ?? {
                    applications: scenario.generated ?? [application('payments-a'), application('payments-b')],
                });
            } else if (method === 'POST' && url.startsWith('/api/v1/applicationsets')) {
                json(200, applicationSet('payments-set'));
            } else if (method === 'DELETE') {
                json(200, {});
            } else if (url.startsWith('/api/v1/applicationsets/')) {
                json(200, applicationSet('payments-set'));
            } else if (url.startsWith('/api/v1/applicationsets')) {
                json(200, { items: scenario.appsets ?? [applicationSet('payments-set')] });
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

async function run(inputs: Record<string, string>) {
    requests = [];
    return runTask({ task: 'ArgoCDAppSetV1', inputs, endpoint: { url: baseUrl, token: 'appset-token' } });
}

function writeManifest(name: string, content: string): string {
    const file = path.join(workDir, name);
    fs.writeFileSync(file, content);
    return file;
}

const APPSET_YAML = `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: payments-set
spec:
  generators:
    - list:
        elements:
          - cluster: in-cluster
  template:
    metadata:
      name: payments-{{cluster}}
`;

describe('list', () => {
    it('lists applicationsets', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'list' });
        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(outputVariable(stdout, 'appSetCount')).toBe('1');
        expect(outputVariable(stdout, 'appSetNames')).toBe('payments-set');
    });

    it('sends projects as repeated query params', async () => {
        scenario = {};
        await run({ command: 'list', projects: 'payments\nplatform', selector: 'team=payments' });
        const url = requests[0]?.url ?? '';
        expect(url).toContain('projects=payments');
        expect(url).toContain('projects=platform');
        expect(url).toContain('selector=team%3Dpayments');
    });

    it('explains an empty result rather than implying none exist', async () => {
        // Project filtering happens after RBAC, so the two cases are indistinguishable.
        scenario = { appsets: [] };
        const { stdout } = await run({ command: 'list' });
        expect(stdout).toContain('or this token cannot see them');
    });
});

describe('get', () => {
    it('reports generators and whether resources are preserved', async () => {
        scenario = { ownedResources: 3 };
        const { stdout } = await run({ command: 'get', name: 'payments-set' });
        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(stdout).toContain('generators: 1');
        expect(outputVariable(stdout, 'generatedAppCount')).toBe('3');
    });
});

describe('create', () => {
    it('sends a BARE body with upsert and dryRun as QUERY parameters', async () => {
        // The asymmetry that matters: create is unwrapped, generate is wrapped.
        scenario = {};
        const file = writeManifest('appset.yaml', APPSET_YAML);
        const { stdout } = await run({ command: 'create', manifestFile: file, upsert: 'true' });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        const post = requests.find((r) => r.method === 'POST');
        expect(post?.url).toContain('upsert=true');

        const body = JSON.parse(post!.body) as Record<string, unknown>;
        expect(body['kind']).toBe('ApplicationSet');
        expect(body).not.toHaveProperty('applicationSet');
        expect(body).not.toHaveProperty('upsert');
    });

    it('passes dryRun as a query parameter and says what it means', async () => {
        scenario = {};
        const file = writeManifest('dry.yaml', APPSET_YAML);
        const { stdout } = await run({ command: 'create', manifestFile: file, dryRun: 'true' });
        expect(requests.find((r) => r.method === 'POST')?.url).toContain('dryRun=true');
        expect(stdout).toContain('use the generate command');
    });

    it('creates every document of a multi-document file', async () => {
        scenario = {};
        const file = writeManifest('two.yaml', `${APPSET_YAML}---\nkind: ApplicationSet\nmetadata: { name: other }\n`);
        const { stdout } = await run({ command: 'create', manifestFile: file });
        expect(outputVariable(stdout, 'appSetCount')).toBe('2');
    });

    it('rejects a manifest that is not an ApplicationSet', async () => {
        scenario = {};
        const file = writeManifest('app.yaml', 'kind: Application\nmetadata: { name: x }\n');
        const { stdout } = await run({ command: 'create', manifestFile: file });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('not "ApplicationSet"');
    });
});

describe('generate', () => {
    it('sends a WRAPPED body and publishes an artifact', async () => {
        scenario = {};
        const file = writeManifest('gen.yaml', APPSET_YAML);
        const { stdout } = await run({ command: 'generate', generateFrom: 'file', manifestFile: file });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(stdout).toContain('##vso[artifact.upload');

        const post = requests.find((r) => r.method === 'POST');
        expect(post?.url).toContain('/applicationsets/generate');
        const body = JSON.parse(post!.body) as Record<string, unknown>;
        // Wrapped, with a capital S -- unlike create.
        expect(body).toHaveProperty('applicationSet');
        expect((body['applicationSet'] as Record<string, unknown>)['kind']).toBe('ApplicationSet');
    });

    it('publishes a compact projection and a full file', async () => {
        scenario = {};
        const file = writeManifest('gen2.yaml', APPSET_YAML);
        const { stdout } = await run({ command: 'generate', generateFrom: 'file', manifestFile: file });

        expect(outputVariable(stdout, 'generatedAppCount')).toBe('2');
        const compact = JSON.parse(outputVariable(stdout, 'generatedApps') as string) as unknown[];
        expect(compact).toHaveLength(2);
        expect(compact[0]).toEqual({
            name: 'payments-a',
            namespace: 'payments',
            project: 'payments',
            server: 'https://kubernetes.default.svc',
        });

        // The full objects live in the file, not the variable.
        const full = JSON.parse(fs.readFileSync(outputVariable(stdout, 'generatedAppsFile') as string, 'utf8'));
        expect(full[0].spec.destination.server).toBe('https://kubernetes.default.svc');
    });

    it('previews the live applicationset when asked by name', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'generate', generateFrom: 'name', name: 'payments-set' });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        // It fetches first, then generates from what the server returned.
        expect(requests[0]?.method).toBe('GET');
        expect(requests.find((r) => r.method === 'POST')?.url).toContain('/generate');
    });

    it('warns when nothing was generated', async () => {
        scenario = { generated: [] };
        const file = writeManifest('empty.yaml', APPSET_YAML);
        const { stdout } = await run({ command: 'generate', generateFrom: 'file', manifestFile: file });
        expect(stdout).toContain('##vso[task.issue type=warning;');
        expect(stdout).toContain('generated no applications');
    });

    it('truncates a huge generator error instead of flooding the result', async () => {
        scenario = {
            generateStatus: 500,
            generateBody: { error: `generator failed\n${'log line\n'.repeat(2000)}`, code: 13 },
        };
        const file = writeManifest('boom.yaml', APPSET_YAML);
        const { stdout } = await run({ command: 'generate', generateFrom: 'file', manifestFile: file });

        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('truncated');
    });

    it('refuses a multi-document file, which cannot be previewed as one', async () => {
        scenario = {};
        const file = writeManifest('multi.yaml', `${APPSET_YAML}---\nkind: ApplicationSet\nmetadata: { name: other }\n`);
        const { stdout } = await run({ command: 'generate', generateFrom: 'file', manifestFile: file });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('one at a time');
    });
});

describe('delete guards', () => {
    it('refuses without confirmation', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'delete', name: 'payments-set' });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('without confirmation');
        expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    });

    it('refuses a label selector', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'delete', selector: 'team=payments', confirm: 'true' });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('does not accept a label selector');
        expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    });

    it('warns that generated applications go too', async () => {
        scenario = { ownedResources: 4 };
        const { stdout } = await run({ command: 'delete', name: 'payments-set', confirm: 'true' });
        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(stdout).toContain('will also delete 4 generated application(s)');
        expect(outputVariable(stdout, 'deletedCount')).toBe('1');
    });

    it('says so when resources are preserved instead', async () => {
        scenario = { preserveResources: true, ownedResources: 4 };
        const { stdout } = await run({ command: 'delete', name: 'payments-set', confirm: 'true' });
        expect(stdout).toContain('preserveResourcesOnDeletion is set');
        expect(stdout).toContain('will remain');
    });

    it('deletes several named applicationsets', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'delete', name: 'one\ntwo', confirm: 'true' });
        expect(outputVariable(stdout, 'deletedCount')).toBe('2');
        expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(2);
    });
});
