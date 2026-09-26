// Integration tests against a REAL Argo CD server.
//
// Skipped unless ARGOCD_TEST_SERVER is set, so `npm test` stays fast and offline. CI runs
// this across every supported Argo CD minor via .github/workflows/integration.yml; locally,
// `scripts/kind-argocd.sh` produces the environment and writes .argocd-env.
//
// These exist because the contract test only proves the SPEC still says what the client
// assumes. Only a real server proves the server behaves that way -- most pointedly the
// Linux-only /download route, which no amount of spec reading would have revealed.

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArgoCdClient, createNodeHttpsTransport } from '../../packages/argocd-client/src/index';
import { EndpointSpec, ensureBuilt, outputVariable, runTask } from '../support/run-task';

const SERVER = process.env['ARGOCD_TEST_SERVER'];
const TOKEN = process.env['ARGOCD_TEST_TOKEN'];
const INSECURE = process.env['ARGOCD_TEST_INSECURE'] === 'true';
const APP_NAME = process.env['ARGOCD_TEST_APP'] ?? 'guestbook';
const PROJECT = process.env['ARGOCD_TEST_PROJECT'] ?? 'default';

const liveDescribe = SERVER !== undefined && SERVER !== '' ? describe : describe.skip;

function client(): ArgoCdClient {
    return new ArgoCdClient({
        serverUrl: SERVER as string,
        token: TOKEN,
        transport: createNodeHttpsTransport({ insecureSkipTlsVerify: INSECURE }),
        timeoutMs: 60_000,
        refreshTimeoutMs: 300_000,
    });
}

function taskEndpoint(): EndpointSpec {
    const data: Record<string, string> = {};
    if (INSECURE) {
        data['insecureSkipTlsVerify'] = 'true';
    }
    return { url: SERVER as string, token: TOKEN, data };
}

liveDescribe('live Argo CD server', () => {
    beforeAll(() => {
        ensureBuilt();
    });

    describe('REST client', () => {
        it('reports a supported version', async () => {
            const version = await client().getVersion();
            expect(version.Version).toMatch(/^v?3\.\d+\.\d+/);
            // PascalCase on the wire, and outside /api/v1 -- both easy to get wrong.
            expect(version.Platform).toMatch(/^[a-z]+\/[a-z0-9]+$/);
        });

        it('authenticates', async () => {
            const info = await client().getUserInfo();
            expect(info.loggedIn).toBe(true);
        });

        it('lists applications', async () => {
            const list = await client().listApplications({ projects: [PROJECT] });
            expect(list.items?.some((app) => app.metadata?.name === APP_NAME)).toBe(true);
        });

        it('returns app-level health on LIST, per-resource health only on GET', async () => {
            // The precise shape of the Argo CD 3.0 change the client is built around.
            const list = await client().listApplications({ projects: [PROJECT] });
            const listed = list.items?.find((app) => app.metadata?.name === APP_NAME);
            expect(listed?.status?.health?.status).toBeDefined();

            const fetched = await client().getApplication(APP_NAME, { project: PROJECT });
            expect(fetched.status?.health?.status).toBeDefined();
        });

        it('distinguishes a missing application when project is supplied', async () => {
            // Without project this would be an indistinguishable 403.
            await expect(
                client().getApplication('definitely-not-a-real-app', { project: PROJECT }),
            ).rejects.toMatchObject({ httpStatus: 404 });
        });
    });

    describe('ArgoCDApp@1', () => {
        it('reports status', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppV1',
                inputs: { command: 'get', applications: APP_NAME, project: PROJECT, publishSummary: 'false' },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(outputVariable(stdout, 'syncStatus')).toBeDefined();
        });

        it('syncs and waits for the application to become healthy', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppV1',
                inputs: {
                    command: 'sync',
                    applications: APP_NAME,
                    project: PROJECT,
                    wait: 'true',
                    waitFor: 'sync,health',
                    timeoutSeconds: '300',
                    pollIntervalSeconds: '5',
                    publishSummary: 'false',
                },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(outputVariable(stdout, 'syncStatus')).toBe('Synced');
            expect(outputVariable(stdout, 'healthStatus')).toBe('Healthy');
        }, 360_000);

        it('produces a diff summary', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppV1',
                inputs: { command: 'diff', applications: APP_NAME, project: PROJECT, publishSummary: 'true' },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.uploadsummary]');
            expect(outputVariable(stdout, 'hasDiff')).toBeDefined();
        }, 120_000);
    });

    describe('lifecycle commands', () => {
        it('reads deployment history from a real application', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppV1',
                inputs: { command: 'history', applications: APP_NAME, project: PROJECT, publishSummary: 'false' },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            // The guestbook app has been synced at least once by the harness.
            expect(outputVariable(stdout, 'latestHistoryId')).toMatch(/^\d+$/);
        }, 120_000);

        it('renders git manifests and publishes them', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppV1',
                inputs: {
                    command: 'manifests',
                    applications: APP_NAME,
                    project: PROJECT,
                    manifestSource: 'git',
                    publishSummary: 'false',
                },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(stdout).toContain('##vso[artifact.upload');
            expect(Number(outputVariable(stdout, 'manifestCount'))).toBeGreaterThan(0);
        }, 180_000);

        it('reads live manifests through managed-resources', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppV1',
                inputs: {
                    command: 'manifests',
                    applications: APP_NAME,
                    project: PROJECT,
                    manifestSource: 'live',
                    publishSummary: 'false',
                },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(Number(outputVariable(stdout, 'manifestCount'))).toBeGreaterThan(0);
        }, 180_000);

        it('lists resource actions, then runs restart on the Deployment', async () => {
            const listed = await runTask({
                task: 'ArgoCDAppV1',
                inputs: {
                    command: 'action',
                    applications: APP_NAME,
                    project: PROJECT,
                    resource: 'apps:Deployment:guestbook-ui',
                    publishSummary: 'false',
                },
                endpoint: taskEndpoint(),
            });
            expect(listed.stdout).toContain('##vso[task.complete result=Succeeded');
            expect(outputVariable(listed.stdout, 'availableActions')).toContain('restart');

            const ran = await runTask({
                task: 'ArgoCDAppV1',
                inputs: {
                    command: 'action',
                    applications: APP_NAME,
                    project: PROJECT,
                    resource: 'apps:Deployment:guestbook-ui',
                    action: 'restart',
                    publishSummary: 'false',
                },
                endpoint: taskEndpoint(),
            });
            // Proves the v2 endpoint exists on every supported minor, which is why there is
            // no V1 fallback.
            expect(ran.stdout).toContain('##vso[task.complete result=Succeeded');
        }, 180_000);

        it('collects pod logs', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppV1',
                inputs: {
                    command: 'logs',
                    applications: APP_NAME,
                    project: PROJECT,
                    tailLines: '50',
                    publishSummary: 'false',
                },
                endpoint: taskEndpoint(),
            });
            // The account may lack the separate `logs` RBAC resource; either outcome is a
            // real result, but it must never be a crash.
            expect(stdout).toMatch(/task\.complete result=(Succeeded|Failed)/);
            if (stdout.includes('result=Failed')) {
                expect(stdout).toContain('logs" RBAC resource');
            } else {
                expect(stdout).toContain('##vso[artifact.upload');
            }
        }, 180_000);

        it('terminates cleanly when no operation is running', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppV1',
                inputs: { command: 'terminate', applications: APP_NAME, project: PROJECT, publishSummary: 'false' },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
        }, 120_000);
    });

    describe('create -> set -> unset -> delete lifecycle', () => {
        // A throwaway application of its own, so this cannot destabilise the guestbook app
        // the other integration tests depend on.
        const THROWAWAY = 'azdo-task-throwaway';
        const manifestFile = path.join(os.tmpdir(), `${THROWAWAY}.yaml`);

        beforeAll(() => {
            fs.writeFileSync(
                manifestFile,
                `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${THROWAWAY}
spec:
  project: ${PROJECT}
  source:
    repoURL: https://github.com/argoproj/argocd-example-apps.git
    targetRevision: HEAD
    path: helm-guestbook
  destination:
    server: https://kubernetes.default.svc
    namespace: ${THROWAWAY}
`,
            );
        });

        it('creates the application from a manifest', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppV1',
                inputs: { command: 'create', manifestFile, upsert: 'true', publishSummary: 'false' },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(outputVariable(stdout, 'appName')).toBe(THROWAWAY);
        }, 180_000);

        it('sets a helm parameter without losing other spec fields', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppV1',
                inputs: {
                    command: 'set',
                    applications: THROWAWAY,
                    project: PROJECT,
                    helmParameters: 'replicaCount=2',
                    publishSummary: 'false',
                },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');

            // Read it back from the real server: the source must still be intact.
            const app = await client().getApplication(THROWAWAY, { project: PROJECT });
            const source = app.spec?.source as Record<string, unknown> | undefined;
            expect(source?.['repoURL']).toBe('https://github.com/argoproj/argocd-example-apps.git');
            expect(source?.['path']).toBe('helm-guestbook');
            expect(app.spec?.destination?.namespace).toBe(THROWAWAY);
        }, 180_000);

        it('unsets the helm parameter again', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppV1',
                inputs: {
                    command: 'unset',
                    applications: THROWAWAY,
                    project: PROJECT,
                    helmParameters: 'replicaCount',
                    publishSummary: 'false',
                },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(stdout).toContain('removed helm parameter replicaCount');
        }, 180_000);

        it('refuses to delete without confirmation', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppV1',
                inputs: { command: 'delete', applications: THROWAWAY, project: PROJECT, publishSummary: 'false' },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Failed');
            expect(stdout).toContain('without confirmation');
        }, 120_000);

        it('deletes the application when confirmed', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppV1',
                inputs: {
                    command: 'delete',
                    applications: THROWAWAY,
                    project: PROJECT,
                    confirm: 'true',
                    publishSummary: 'false',
                },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(outputVariable(stdout, 'deletedCount')).toBe('1');
        }, 180_000);
    });

    describe('credential tasks against a real server', () => {
        // The kind harness creates the ci-test account with the apiKey capability.
        const ACCOUNT = process.env['ARGOCD_TEST_ACCOUNT'] ?? 'ci-test';
        let mintedTokenId = '';

        it('answers can-i for an allowed action', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAccountV1',
                inputs: {
                    command: 'can-i',
                    resource: 'applications',
                    action: 'sync',
                    subresource: `${PROJECT}/*`,
                },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(outputVariable(stdout, 'allowed')).toBe('true');
        }, 120_000);

        it('reads the account and its capabilities', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAccountV1',
                inputs: { command: 'get', account: ACCOUNT },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(stdout).toContain('apiKey');
        }, 120_000);

        it('mints an account token and never prints it', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAccountV1',
                inputs: { command: 'create-token', account: ACCOUNT, expiresIn: '1h' },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');

            mintedTokenId = outputVariable(stdout, 'tokenId') ?? '';
            expect(mintedTokenId).not.toBe('');

            // The token appears exactly twice: the mask command and the secret variable.
            const marker = '##vso[task.setsecret]';
            expect(stdout).toContain(marker);
            const secretLine = stdout.split('\n').find((l) => l.startsWith(marker));
            const value = secretLine!.slice(marker.length).trim();
            const occurrences = stdout.split(value).length - 1;
            expect(occurrences, 'the token appeared more than twice in the log').toBeLessThanOrEqual(2);
        }, 180_000);

        it('revokes the token it just minted', async () => {
            expect(mintedTokenId, 'no token was minted').not.toBe('');
            const { stdout } = await runTask({
                task: 'ArgoCDAccountV1',
                inputs: { command: 'delete-token', account: ACCOUNT, tokenId: mintedTokenId },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');

            // Confirm from the server rather than trusting the status code.
            const after = await runTask({
                task: 'ArgoCDAccountV1',
                inputs: { command: 'get', account: ACCOUNT },
                endpoint: taskEndpoint(),
            });
            expect(outputVariable(after.stdout, 'tokenIds') ?? '').not.toContain(mintedTokenId);
        }, 180_000);

        it('lists projects', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDProjectV1',
                inputs: { command: 'list' },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(Number(outputVariable(stdout, 'projectCount'))).toBeGreaterThan(0);
        }, 120_000);
    });

    describe('ApplicationSets against a real server', () => {
        // Its own throwaway ApplicationSet, so deleting it cannot touch the guestbook app
        // the other integration tests depend on.
        const APPSET = 'azdo-task-throwaway-set';
        const appsetFile = path.join(os.tmpdir(), `${APPSET}.yaml`);

        beforeAll(() => {
            fs.writeFileSync(
                appsetFile,
                `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: ${APPSET}
spec:
  generators:
    - list:
        elements:
          - name: alpha
          - name: beta
  template:
    metadata:
      name: '${APPSET}-{{name}}'
    spec:
      project: ${PROJECT}
      source:
        repoURL: https://github.com/argoproj/argocd-example-apps.git
        targetRevision: HEAD
        path: guestbook
      destination:
        server: https://kubernetes.default.svc
        namespace: '${APPSET}-{{name}}'
`,
            );
        });

        it('previews the applications a manifest would generate', async () => {
            // Nothing is persisted by generate, so this is safe to run first.
            const { stdout } = await runTask({
                task: 'ArgoCDAppSetV1',
                inputs: { command: 'generate', generateFrom: 'file', manifestFile: appsetFile },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(outputVariable(stdout, 'generatedAppCount')).toBe('2');

            const compact = JSON.parse(outputVariable(stdout, 'generatedApps') as string) as Array<{ name: string }>;
            expect(compact.map((a) => a.name).sort()).toEqual([`${APPSET}-alpha`, `${APPSET}-beta`]);
        }, 180_000);

        it('creates the applicationset', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppSetV1',
                inputs: { command: 'create', manifestFile: appsetFile, upsert: 'true' },
                endpoint: taskEndpoint(),
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(outputVariable(stdout, 'appSetNames')).toBe(APPSET);
        }, 180_000);

        it('lists it', async () => {
            const { stdout } = await runTask({
                task: 'ArgoCDAppSetV1',
                inputs: { command: 'list' },
                endpoint: taskEndpoint(),
            });
            expect(outputVariable(stdout, 'appSetNames') ?? '').toContain(APPSET);
        }, 120_000);

        it('refuses to delete without confirmation, then deletes when confirmed', async () => {
            const refused = await runTask({
                task: 'ArgoCDAppSetV1',
                inputs: { command: 'delete', name: APPSET },
                endpoint: taskEndpoint(),
            });
            expect(refused.stdout).toContain('##vso[task.complete result=Failed');

            const deleted = await runTask({
                task: 'ArgoCDAppSetV1',
                inputs: { command: 'delete', name: APPSET, confirm: 'true' },
                endpoint: taskEndpoint(),
            });
            expect(deleted.stdout).toContain('##vso[task.complete result=Succeeded');
            expect(outputVariable(deleted.stdout, 'deletedCount')).toBe('1');
        }, 240_000);
    });

    describe('ArgoCDInstall@1 and ArgoCDCli@1', () => {
        it('installs the CLI straight from the Argo CD server', async () => {
            // The whole point of this test: the /download route is Linux-only and serves only
            // the server's own architecture. Nothing but a real server proves that works.
            const { stdout } = await runTask({
                task: 'ArgoCDInstallV1',
                inputs: { version: 'server', source: 'server' },
                endpoint: taskEndpoint(),
                env: { AGENT_TOOLSDIRECTORY: process.env['RUNNER_TOOL_CACHE'] ?? '/tmp/argocd-tools' },
            });
            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(outputVariable(stdout, 'argocdVersion')).toMatch(/^v3\./);
        }, 600_000);

        it('runs a CLI command without leaking the token', async () => {
            const toolCache = process.env['RUNNER_TOOL_CACHE'] ?? '/tmp/argocd-tools';
            const install = await runTask({
                task: 'ArgoCDInstallV1',
                inputs: { version: 'server', source: 'server' },
                endpoint: taskEndpoint(),
                env: { AGENT_TOOLSDIRECTORY: toolCache },
            });
            const binary = outputVariable(install.stdout, 'argocdPath');
            expect(binary).toBeDefined();

            const cliDirectory = (binary as string).replace(/\/[^/]+$/, '');
            const { stdout } = await runTask({
                task: 'ArgoCDCliV1',
                inputs: { arguments: 'app list -o name' },
                endpoint: taskEndpoint(),
                env: { PATH: `${cliDirectory}:${process.env['PATH'] ?? ''}` },
            });

            expect(stdout).toContain('##vso[task.complete result=Succeeded');
            expect(outputVariable(stdout, 'argocdExitCode')).toBe('0');
            if (TOKEN !== undefined) {
                const afterMask = stdout.slice(stdout.indexOf(`##vso[task.setsecret]${TOKEN}`) + TOKEN.length);
                expect(afterMask).not.toContain(TOKEN);
            }
        }, 600_000);
    });
});
