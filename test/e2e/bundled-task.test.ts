// End-to-end test of the SHIPPED ArgoCDApp artifact.
//
// This runs dist/tasks/ArgoCDAppV1/index.js -- the actual esbuild bundle that goes into the
// VSIX -- against a local HTTP server replaying Argo CD responses, with the same INPUT_* /
// ENDPOINT_* environment the agent provides. The child-process plumbing lives in
// test/support/run-task.ts so the integration suite drives tasks the same way.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { attachmentFrom, ensureBuilt, outputVariable, runTask, summaryPathFrom } from '../support/run-task';

const TOKEN = 'super-secret-argocd-token';

interface RequestLog {
    method: string;
    url: string;
    authorization: string | undefined;
    body: string;
}

interface Scenario {
    /** Application documents returned by successive GETs, last one repeating. */
    applications: unknown[];
    managedResources?: unknown;
    resourceTree?: unknown;
    syncStatus?: number;
    syncBody?: unknown;
}

let server: http.Server;
let baseUrl: string;
let requests: RequestLog[] = [];
let scenario: Scenario;
let getCount = 0;

function application(overrides: {
    sync?: string;
    health?: string;
    phase?: string;
    message?: string;
    revision?: string;
}): unknown {
    return {
        metadata: { name: 'payments', namespace: 'argocd' },
        spec: { project: 'payments' },
        status: {
            sync: { status: overrides.sync ?? 'Synced', revision: overrides.revision ?? 'a'.repeat(40) },
            health: { status: overrides.health ?? 'Healthy', message: overrides.message },
            ...(overrides.phase === undefined
                ? {}
                : { operationState: { phase: overrides.phase, message: overrides.message } }),
        },
    };
}

beforeAll(async () => {
    ensureBuilt();

    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const url = req.url ?? '';
            requests.push({
                method: req.method ?? '',
                url,
                authorization: req.headers.authorization,
                body: Buffer.concat(chunks).toString('utf8'),
            });

            const send = (status: number, payload: unknown): void => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(payload));
            };

            if (url.includes('/managed-resources')) {
                send(200, scenario.managedResources ?? { items: [] });
            } else if (url.includes('/resource-tree')) {
                send(200, scenario.resourceTree ?? { nodes: [] });
            } else if (url.includes('/sync')) {
                send(scenario.syncStatus ?? 200, scenario.syncBody ?? application({}));
            } else if (url.includes('/api/v1/applications/')) {
                const index = Math.min(getCount, scenario.applications.length - 1);
                getCount += 1;
                send(200, scenario.applications[index]);
            } else {
                send(404, { error: 'not found', code: 5 });
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

/** Run the bundled ArgoCDApp task against the replay server. */
async function runAppTask(inputs: Record<string, string>): Promise<{ stdout: string; exitCode: number }> {
    return runTask({
        task: 'ArgoCDAppV1',
        inputs,
        endpoint: { url: baseUrl, token: TOKEN },
    });
}

function resetScenario(next: Scenario): void {
    scenario = next;
    requests = [];
    getCount = 0;
}

describe('bundled ArgoCDApp task', () => {
    it('reports a healthy application and sets output variables', async () => {
        resetScenario({ applications: [application({})] });

        const { stdout } = await runAppTask({
            command: 'get',
            applications: 'payments',
            project: 'payments',
            publishSummary: 'false',
        });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(outputVariable(stdout, 'syncStatus')).toBe('Synced');
        expect(outputVariable(stdout, 'healthStatus')).toBe('Healthy');
        expect(stdout).toContain('variable=appUrl');
    });

    it('masks the token before making any request', async () => {
        resetScenario({ applications: [application({})] });

        const { stdout } = await runAppTask({
            command: 'get',
            applications: 'payments',
            project: 'payments',
            publishSummary: 'false',
        });

        // The mask command must be emitted, and the raw token must never be printed.
        const maskIndex = stdout.indexOf(`##vso[task.setsecret]${TOKEN}`);
        expect(maskIndex, 'setsecret was not emitted').toBeGreaterThanOrEqual(0);
        const afterMask = stdout.slice(maskIndex + `##vso[task.setsecret]${TOKEN}`.length);
        expect(afterMask).not.toContain(TOKEN);
        expect(requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('publishes the revision of a multi-source application', async () => {
        // A multi-source app (spec.sources) gets status.sync.revisions[]; the singular
        // status.sync.revision is present and EMPTY. Reading only the singular published
        // an empty revision output for every such app.
        resetScenario({
            applications: [
                {
                    metadata: { name: 'payments', namespace: 'argocd' },
                    spec: { project: 'payments' },
                    status: {
                        sync: { status: 'Synced', revision: '', revisions: ['a'.repeat(40), 'b'.repeat(40)] },
                        health: { status: 'Healthy' },
                    },
                },
            ],
        });

        const { stdout } = await runAppTask({
            command: 'get',
            applications: 'payments',
            project: 'payments',
            publishSummary: 'false',
        });

        expect(outputVariable(stdout, 'revision')).toBe(`${'a'.repeat(40)},${'b'.repeat(40)}`);
        expect(
            JSON.parse(outputVariable(stdout, 'revisions') as string),
            'the list must be published so a chart version can be told from a SHA',
        ).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
        const apps = JSON.parse(outputVariable(stdout, 'appsJson') as string) as Array<{ revision?: string }>;
        expect(apps[0]?.revision, 'appsJson must carry it too').toBe(`${'a'.repeat(40)},${'b'.repeat(40)}`);
    });

    it('sends the project parameter so errors stay meaningful', async () => {
        resetScenario({ applications: [application({})] });
        await runAppTask({ command: 'get', applications: 'payments', project: 'payments', publishSummary: 'false' });
        expect(requests[0]?.url).toContain('project=payments');
    });

    it('warns when no project is supplied', async () => {
        resetScenario({ applications: [application({})] });
        const { stdout } = await runAppTask({ command: 'get', applications: 'payments', publishSummary: 'false' });
        expect(stdout).toContain('##vso[task.issue type=warning;');
        expect(stdout).toContain('permission denied');
    });

    it('omits refresh entirely when not asked for one', async () => {
        resetScenario({ applications: [application({})] });
        await runAppTask({
            command: 'get',
            applications: 'payments',
            project: 'payments',
            refresh: 'none',
            publishSummary: 'false',
        });
        expect(requests[0]?.url).not.toContain('refresh');
    });

    it('sends refresh=hard for a hard refresh', async () => {
        resetScenario({ applications: [application({})] });
        await runAppTask({
            command: 'refresh',
            applications: 'payments',
            project: 'payments',
            hard: 'true',
            publishSummary: 'false',
        });
        expect(requests[0]?.url).toContain('refresh=hard');
    });

    it('syncs, then polls until the application converges', async () => {
        resetScenario({
            applications: [
                application({ sync: 'OutOfSync', health: 'Progressing' }),
                application({ sync: 'Synced', health: 'Progressing' }),
                application({ sync: 'Synced', health: 'Healthy' }),
            ],
        });

        const { stdout } = await runAppTask({
            command: 'sync',
            applications: 'payments',
            project: 'payments',
            prune: 'true',
            syncOptions: 'CreateNamespace=true\nServerSideApply=true',
            wait: 'true',
            waitFor: 'sync,health',
            timeoutSeconds: '30',
            pollIntervalSeconds: '1',
            publishSummary: 'false',
        });

        const sync = requests.find((r) => r.method === 'POST');
        expect(sync, 'no sync request was made').toBeDefined();

        // The wrapper object is the whole reason encodeSyncBody exists.
        const body = JSON.parse(sync!.body) as { syncOptions: unknown; prune: boolean; project: string };
        expect(body.syncOptions).toEqual({ items: ['CreateNamespace=true', 'ServerSideApply=true'] });
        expect(body.prune).toBe(true);
        expect(body.project).toBe('payments');

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
    });

    it('fails fast when the sync operation itself fails', async () => {
        resetScenario({
            applications: [application({ sync: 'OutOfSync', phase: 'Failed', message: 'one or more objects failed' })],
        });

        const { stdout } = await runAppTask({
            command: 'sync',
            applications: 'payments',
            project: 'payments',
            wait: 'true',
            timeoutSeconds: '30',
            pollIntervalSeconds: '1',
            publishSummary: 'false',
        });

        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('one or more objects failed');
    });

    it('reports succeeded-with-issues on timeout when configured to', async () => {
        resetScenario({ applications: [application({ sync: 'OutOfSync', health: 'Progressing' })] });

        const { stdout } = await runAppTask({
            command: 'wait',
            applications: 'payments',
            project: 'payments',
            waitFor: 'sync,health',
            timeoutSeconds: '1',
            pollIntervalSeconds: '1',
            failOnTimeout: 'false',
            publishSummary: 'false',
        });

        expect(stdout).toContain('##vso[task.complete result=SucceededWithIssues');
    });

    it('surfaces a diff and publishes a summary file', async () => {
        resetScenario({
            applications: [application({})],
            managedResources: {
                items: [
                    {
                        group: 'apps',
                        kind: 'Deployment',
                        namespace: 'prod',
                        name: 'api',
                        modified: true,
                        liveState: JSON.stringify({ spec: { replicas: 2 } }),
                        targetState: JSON.stringify({ spec: { replicas: 3 } }),
                    },
                ],
            },
        });

        const { stdout } = await runAppTask({
            command: 'diff',
            applications: 'payments',
            project: 'payments',
            failOnDiff: 'false',
            publishSummary: 'true',
        });

        expect(stdout).toContain('##vso[task.complete result=SucceededWithIssues');
        expect(outputVariable(stdout, 'hasDiff')).toBe('true');
        expect(outputVariable(stdout, 'diffResourceCount')).toBe('1');

        const summaryPath = summaryPathFrom(stdout);
        expect(summaryPath, 'no summary was published').toBeDefined();
        const markdown = fs.readFileSync(summaryPath as string, 'utf8');
        expect(markdown).toContain('```diff');
        expect(markdown).toContain('apps/Deployment prod/api');
    });

    it('fails the task on a diff when used as a gate', async () => {
        resetScenario({
            applications: [application({})],
            managedResources: {
                items: [{ kind: 'ConfigMap', name: 'cm', modified: true, liveState: '{"a":1}', targetState: '{"a":2}' }],
            },
        });

        const { stdout } = await runAppTask({
            command: 'diff',
            applications: 'payments',
            project: 'payments',
            failOnDiff: 'true',
            publishSummary: 'false',
        });

        expect(stdout).toContain('##vso[task.complete result=Failed');
    });

    it('publishes a run attachment for the Argo CD tab', async () => {
        resetScenario({ applications: [application({})] });

        const { stdout } = await runAppTask({
            command: 'get',
            applications: 'payments',
            project: 'payments',
            publishSummary: 'false',
        });

        // publishSummary gates the tab attachment too -- it is the same opt-out.
        expect(attachmentFrom(stdout), 'attachment published despite publishSummary=false').toBeUndefined();

        const second = await runAppTask({
            command: 'get',
            applications: 'payments',
            project: 'payments',
            publishSummary: 'true',
        });

        const run = attachmentFrom(second.stdout) as
            | { schema: number; task: string; command: string; applications: Array<Record<string, unknown>> }
            | undefined;
        expect(run, 'no run attachment was published').toBeDefined();
        expect(run?.schema, 'the tab switches on this').toBe(1);
        expect(run?.task).toBe('ArgoCDApp@1');
        expect(run?.command).toBe('get');
        expect(run?.applications?.[0]).toMatchObject({ name: 'payments', syncStatus: 'Synced', healthStatus: 'Healthy' });
    });

    it('never puts the connection token in the attachment', async () => {
        // The attachment is a file we write and publish; the agent masks its log stream, not
        // this. The endpoint token is registered as a secret, so the guard must catch it.
        resetScenario({ applications: [application({})] });
        const { stdout } = await runAppTask({
            command: 'get',
            applications: 'payments',
            project: 'payments',
            publishSummary: 'true',
        });
        const raw = JSON.stringify(attachmentFrom(stdout) ?? {});
        expect(raw).not.toContain(TOKEN);
        expect(raw.length, 'attachment was empty, so the assertion above proved nothing').toBeGreaterThan(50);
    });

    it('fails with a readable message when no application is specified', async () => {
        resetScenario({ applications: [application({})] });
        const { stdout } = await runAppTask({ command: 'get', project: 'payments', publishSummary: 'false' });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('Specify at least one application');
    });

    it('rejects an unknown wait condition rather than silently waiting for nothing', async () => {
        resetScenario({ applications: [application({})] });
        const { stdout } = await runAppTask({
            command: 'wait',
            applications: 'payments',
            project: 'payments',
            waitFor: 'helth',
            publishSummary: 'false',
        });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('Unknown wait condition "helth"');
    });
});
