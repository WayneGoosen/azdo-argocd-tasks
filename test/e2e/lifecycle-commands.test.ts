// End-to-end tests for the Phase 2a lifecycle commands, against the shipped bundle.
//
// The cases worth having here are the ones unit tests cannot reach: the auto-sync rollback
// rejection (which depends on reading the app before deciding), a log stream whose error
// arrives mid-body with HTTP 200, and the artifact-upload logging commands.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { ensureBuilt, outputVariable, runTask, summaryPathFrom } from '../support/run-task';

const TOKEN = 'lifecycle-token';

interface Scenario {
    application?: unknown;
    manifests?: unknown;
    managedResources?: unknown;
    actions?: unknown;
    logBody?: string;
    treeNodes?: unknown[];
    rollbackStatus?: number;
    rollbackBody?: unknown;
}

let server: http.Server;
let baseUrl: string;
let scenario: Scenario = {};
let requests: Array<{ method: string; url: string; body: string }> = [];

function application(overrides: {
    history?: unknown[];
    automated?: boolean;
    phase?: string;
} = {}): unknown {
    return {
        metadata: { name: 'payments', namespace: 'argocd' },
        spec: {
            project: 'payments',
            ...(overrides.automated === true ? { syncPolicy: { automated: { prune: false } } } : {}),
        },
        status: {
            sync: { status: 'Synced', revision: 'a'.repeat(40) },
            health: { status: 'Healthy' },
            ...(overrides.phase === undefined ? {} : { operationState: { phase: overrides.phase } }),
            history: overrides.history ?? [
                { id: 1, revision: 'a'.repeat(40), deployedAt: '2026-01-01T00:00:00Z' },
                { id: 2, revision: 'b'.repeat(40), deployedAt: '2026-01-02T00:00:00Z' },
                { id: 3, revision: 'c'.repeat(40), deployedAt: '2026-01-03T00:00:00Z' },
            ],
        },
    };
}

beforeAll(async () => {
    ensureBuilt();
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const url = req.url ?? '';
            requests.push({ method: req.method ?? '', url, body: Buffer.concat(chunks).toString('utf8') });

            const json = (status: number, payload: unknown): void => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
            };

            if (url.includes('/rollback')) {
                json(scenario.rollbackStatus ?? 200, scenario.rollbackBody ?? application());
            } else if (url.includes('/resource/actions/v2')) {
                json(200, {});
            } else if (url.includes('/resource/actions')) {
                json(200, scenario.actions ?? { actions: [] });
            } else if (url.includes('/manifests')) {
                json(200, scenario.manifests ?? { manifests: [], revision: 'c'.repeat(40) });
            } else if (url.includes('/managed-resources')) {
                json(200, scenario.managedResources ?? { items: [] });
            } else if (url.includes('/logs')) {
                // NDJSON, chunked, always HTTP 200 -- errors arrive inside the body.
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(scenario.logBody ?? '');
            } else if (url.includes('/resource-tree')) {
                // The action command reads version and namespace from here, because both
                // are required by the API but neither is in the user's resource input.
                json(200, {
                    nodes: scenario.treeNodes ?? [
                        {
                            group: 'apps',
                            kind: 'Deployment',
                            name: 'payments-api',
                            namespace: 'payments',
                            version: 'v1',
                        },
                    ],
                });
            } else if (url.includes('/operation')) {
                json(200, {});
            } else if (url.includes('/api/v1/applications/')) {
                json(200, scenario.application ?? application());
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
        inputs: { applications: 'payments', project: 'payments', ...inputs },
        endpoint: { url: baseUrl, token: TOKEN },
    });
}

describe('history', () => {
    it('lists history newest first and publishes the latest id', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'history', publishSummary: 'true' });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(outputVariable(stdout, 'latestHistoryId')).toBe('3');

        const summary = summaryPathFrom(stdout);
        expect(summary).toBeDefined();
        const markdown = fs.readFileSync(summary as string, 'utf8');
        expect(markdown).toContain('Deployment history');
        expect(markdown.indexOf('| 3 |')).toBeLessThan(markdown.indexOf('| 1 |'));
    });

    it('says so plainly when there is no history', async () => {
        scenario = { application: application({ history: [] }) };
        const { stdout } = await run({ command: 'history', publishSummary: 'true' });
        const markdown = fs.readFileSync(summaryPathFrom(stdout) as string, 'utf8');
        expect(markdown).toContain('No deployment history');
    });
});

describe('rollback', () => {
    it('rolls back to the previous revision and sends id as a number', async () => {
        scenario = {};
        const { stdout } = await run({
            command: 'rollback',
            historyId: 'previous',
            wait: 'true',
            timeoutSeconds: '30',
            pollIntervalSeconds: '1',
            publishSummary: 'false',
        });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(outputVariable(stdout, 'rolledBackTo')).toBe('2');

        const rollback = requests.find((r) => r.url.includes('/rollback'));
        expect(rollback).toBeDefined();
        const body = JSON.parse(rollback!.body) as { id: unknown };
        expect(body.id).toBe(2);
        expect(typeof body.id).toBe('number');
    });

    it('refuses before making a request when automated sync is enabled', async () => {
        scenario = { application: application({ automated: true }) };
        const { stdout } = await run({ command: 'rollback', historyId: 'previous', publishSummary: 'false' });

        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('automated sync');
        expect(stdout).toContain('GitOps-native');
        // The whole point of pre-checking: no rollback request is ever sent.
        expect(requests.some((r) => r.url.includes('/rollback'))).toBe(false);
    });

    it('rejects a history id that does not exist', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'rollback', historyId: '99', publishSummary: 'false' });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('Available IDs: 3, 2, 1');
    });

    it('skips waiting for a dry run', async () => {
        scenario = {};
        const { stdout } = await run({
            command: 'rollback',
            historyId: '1',
            dryRun: 'true',
            publishSummary: 'false',
        });
        expect(stdout).toContain('dry run');
        expect(stdout).toContain('##vso[task.complete result=Succeeded');
    });
});

describe('action', () => {
    it('lists available actions when none is named', async () => {
        scenario = { actions: { actions: [{ name: 'restart', params: [] }, { name: 'pause', disabled: true }] } };
        const { stdout } = await run({
            command: 'action',
            resource: 'apps:Deployment:payments-api',
            publishSummary: 'false',
        });

        expect(stdout).toContain('Available actions');
        expect(stdout).toContain('restart');
        expect(stdout).toContain('pause [disabled]');
        expect(outputVariable(stdout, 'availableActions')).toBe('restart,pause');
    });

    it('runs an action through the v2 endpoint', async () => {
        scenario = {};
        const { stdout } = await run({
            command: 'action',
            resource: 'apps:Deployment:payments-api',
            action: 'restart',
            publishSummary: 'false',
        });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        const call = requests.find((r) => r.method === 'POST');
        expect(call?.url).toContain('/resource/actions/v2');
        expect(JSON.parse(call!.body)).toMatchObject({ action: 'restart', kind: 'Deployment', resourceName: 'payments-api' });
    });

    it('passes action parameters as name/value strings', async () => {
        scenario = {};
        await run({
            command: 'action',
            resource: 'apps:Deployment:payments-api',
            action: 'scale',
            actionParameters: 'replicas=3',
            publishSummary: 'false',
        });
        const call = requests.find((r) => r.method === 'POST');
        expect(JSON.parse(call!.body).resourceActionParameters).toEqual([{ name: 'replicas', value: '3' }]);
    });

    it('names the alternatives when the resource is not in the application', async () => {
        // version and namespace are resolved from the resource tree, so a resource that
        // is not managed by the application cannot be acted on -- say which ones are.
        scenario = { treeNodes: [{ group: 'apps', kind: 'Deployment', name: 'something-else', namespace: 'x', version: 'v1' }] };
        const { stdout } = await run({
            command: 'action',
            resource: 'apps:Deployment:payments-api',
            action: 'restart',
            publishSummary: 'false',
        });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('is not managed by application');
        expect(stdout).toContain('apps:Deployment:something-else');
    });

    it('sends the resolved version and namespace with the action', async () => {
        scenario = {};
        await run({
            command: 'action',
            resource: 'apps:Deployment:payments-api',
            action: 'restart',
            publishSummary: 'false',
        });
        const call = requests.find((r) => r.method === 'POST');
        const body = JSON.parse(call!.body) as { version: string; namespace: string };
        expect(body.version).toBe('v1');
        expect(body.namespace).toBe('payments');
    });

    it('requires a resource', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'action', action: 'restart', publishSummary: 'false' });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('"resource" input is required');
    });
});

describe('manifests', () => {
    it('renders git manifests and publishes an artifact', async () => {
        scenario = {
            manifests: { manifests: ['{"kind":"Service","metadata":{"name":"api"}}'], revision: 'c'.repeat(40) },
        };
        const { stdout } = await run({ command: 'manifests', manifestSource: 'git', publishSummary: 'false' });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(stdout).toContain('##vso[artifact.upload');
        expect(outputVariable(stdout, 'manifestCount')).toBe('1');

        const file = outputVariable(stdout, 'manifestFile');
        expect(fs.readFileSync(file as string, 'utf8')).toContain('"kind": "Service"');
    });

    it('reads live state from managed-resources rather than the manifests endpoint', async () => {
        scenario = {
            managedResources: { items: [{ kind: 'Service', name: 'api', liveState: '{"kind":"Service"}' }] },
        };
        const { stdout } = await run({ command: 'manifests', manifestSource: 'live', publishSummary: 'false' });

        expect(outputVariable(stdout, 'manifestCount')).toBe('1');
        expect(requests.some((r) => r.url.includes('/managed-resources'))).toBe(true);
        expect(requests.some((r) => r.url.includes('/manifests'))).toBe(false);
    });

    it('warns that a revision is meaningless for live state', async () => {
        scenario = {};
        const { stdout } = await run({
            command: 'manifests',
            manifestSource: 'live',
            revision: 'abc',
            publishSummary: 'false',
        });
        expect(stdout).toContain('##vso[task.issue type=warning;');
        expect(stdout).toContain('revision is ignored');
    });
});

describe('logs', () => {
    it('collects log lines and publishes an artifact', async () => {
        scenario = {
            logBody: [
                JSON.stringify({ result: { content: 'starting up', podName: 'api-1' } }),
                JSON.stringify({ result: { content: 'ready', podName: 'api-1' } }),
                JSON.stringify({ result: { last: true, podName: 'api-1' } }),
            ].join('\n'),
        };
        const { stdout } = await run({ command: 'logs', tailLines: '100', publishSummary: 'false' });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(stdout).toContain('##vso[artifact.upload');
        expect(outputVariable(stdout, 'logLineCount')).toBe('2');
        expect(fs.readFileSync(outputVariable(stdout, 'logFile') as string, 'utf8')).toContain('starting up');
    });

    it('fails on an error delivered mid-stream despite HTTP 200', async () => {
        scenario = {
            logBody: [
                JSON.stringify({ result: { content: 'some output' } }),
                JSON.stringify({ error: { grpc_code: 7, http_code: 403, message: 'permission denied' } }),
            ].join('\n'),
        };
        const { stdout } = await run({ command: 'logs', publishSummary: 'false' });

        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('logs" RBAC resource');
    });

    it('warns when nothing matched rather than reporting silent success', async () => {
        scenario = { logBody: '' };
        const { stdout } = await run({ command: 'logs', publishSummary: 'false' });
        expect(stdout).toContain('##vso[task.issue type=warning;');
        expect(stdout).toContain('No log entries');
    });
});

describe('terminate', () => {
    it('terminates a running operation', async () => {
        scenario = { application: application({ phase: 'Running' }) };
        const { stdout } = await run({ command: 'terminate', publishSummary: 'false' });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(outputVariable(stdout, 'terminatedCount')).toBe('1');
        const call = requests.find((r) => r.method === 'DELETE');
        expect(call?.url).toContain('/operation');
    });

    it('is a no-op when nothing is running', async () => {
        scenario = {};
        const { stdout } = await run({ command: 'terminate', publishSummary: 'false' });
        expect(stdout).toContain('no operation in progress');
        expect(outputVariable(stdout, 'terminatedCount')).toBe('0');
        expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    });
});
