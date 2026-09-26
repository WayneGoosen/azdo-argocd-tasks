// End-to-end tests for ArgoCDProject and ArgoCDAccount against the shipped bundles.
//
// The properties worth proving here:
//   * a minted token is MASKED before anything could print it, and never appears in the log
//   * project delete-token VERIFIES by re-reading, because the endpoint returns 200 even
//     when it deleted nothing
//   * can-i builds a multi-segment subresource as real path segments, not percent-encoded

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { ensureBuilt, outputVariable, runTask } from '../support/run-task';

const MINTED_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.minted-secret-token-value.signature';

interface Scenario {
    /** Token ids present on the project role, consulted on each read. */
    projectTokens?: string[];
    /** Simulate the silent-success case: the delete does nothing. */
    deleteDoesNothing?: boolean;
    accountCapabilities?: string[];
    accountTokens?: string[];
    canIValue?: string;
    roleName?: string;
}

let server: http.Server;
let baseUrl: string;
let scenario: Scenario = {};
let requests: Array<{ method: string; url: string; body: string }> = [];

beforeAll(async () => {
    ensureBuilt();
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

            const roleName = scenario.roleName ?? 'ado-ci';

            if (method === 'POST' && url.includes('/roles/') && url.includes('/token')) {
                // Mirror the real server: the response carries the token and nothing else.
                if (!scenario.deleteDoesNothing) {
                    scenario.projectTokens = [...(scenario.projectTokens ?? []), readSentId(chunks)];
                }
                json(200, { token: MINTED_TOKEN });
            } else if (method === 'DELETE' && url.includes('/roles/')) {
                if (!scenario.deleteDoesNothing) {
                    const id = new URL(url, baseUrl).searchParams.get('id');
                    scenario.projectTokens = (scenario.projectTokens ?? []).filter((t) => t !== id);
                }
                // Returns 200 either way -- that is the behaviour being guarded against.
                json(200, {});
            } else if (url.startsWith('/api/v1/projects/')) {
                json(200, {
                    metadata: { name: 'payments' },
                    spec: {
                        description: 'Payments team',
                        roles: [
                            {
                                name: roleName,
                                policies: ['p, proj:payments:ado-ci, applications, sync, payments/*, allow'],
                                jwtTokens: (scenario.projectTokens ?? []).map((id) => ({ id, iat: 1767225600, exp: 0 })),
                            },
                        ],
                    },
                });
            } else if (url === '/api/v1/projects') {
                json(200, { items: [{ metadata: { name: 'payments' } }, { metadata: { name: 'platform' } }] });
            } else if (method === 'POST' && url.includes('/account/')) {
                scenario.accountTokens = [...(scenario.accountTokens ?? []), readSentId(chunks)];
                json(200, { token: MINTED_TOKEN });
            } else if (method === 'DELETE' && url.includes('/account/')) {
                const id = url.split('/').pop() ?? '';
                scenario.accountTokens = (scenario.accountTokens ?? []).filter((t) => t !== id);
                json(200, {});
            } else if (url.startsWith('/api/v1/account/can-i/')) {
                json(200, { value: scenario.canIValue ?? 'yes' });
            } else if (url === '/api/v1/account') {
                json(200, { items: [{ name: 'ado-ci', enabled: true, capabilities: ['apiKey'] }] });
            } else if (url.startsWith('/api/v1/account/')) {
                json(200, {
                    name: 'ado-ci',
                    enabled: true,
                    capabilities: scenario.accountCapabilities ?? ['apiKey'],
                    tokens: (scenario.accountTokens ?? []).map((id) => ({ id, issuedAt: 1767225600, expiresAt: 0 })),
                });
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

function readSentId(chunks: Buffer[]): string {
    return (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: string }).id ?? '';
}

async function run(task: string, inputs: Record<string, string>) {
    requests = [];
    return runTask({ task, inputs, endpoint: { url: baseUrl, token: 'endpoint-token' } });
}

/** The token must be masked, and must not appear in the log after the mask command. */
function assertMasked(stdout: string): void {
    const marker = `##vso[task.setsecret]${MINTED_TOKEN}`;
    const index = stdout.indexOf(marker);
    expect(index, 'the minted token was never masked').toBeGreaterThanOrEqual(0);
    const afterMask = stdout.slice(index + marker.length);
    // The secret output variable line is allowed to carry it; nothing else is.
    const leaks = afterMask
        .split('\n')
        .filter((line) => line.includes(MINTED_TOKEN))
        .filter((line) => !line.includes('issecret=true'));
    expect(leaks, `token leaked into the log: ${leaks.join(' | ')}`).toEqual([]);
}

describe('ArgoCDProject', () => {
    it('lists projects', async () => {
        scenario = {};
        const { stdout } = await run('ArgoCDProjectV1', { command: 'list' });
        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(outputVariable(stdout, 'projectCount')).toBe('2');
    });

    it('reads a project and its roles', async () => {
        scenario = { projectTokens: ['abc'] };
        const { stdout } = await run('ArgoCDProjectV1', { command: 'get', project: 'payments' });
        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(stdout).toContain('ado-ci');
        expect(outputVariable(stdout, 'roleCount')).toBe('1');
    });

    it('mints a token, masks it, and sends expiresIn as a NUMBER of seconds', async () => {
        scenario = {};
        const { stdout } = await run('ArgoCDProjectV1', {
            command: 'create-token',
            project: 'payments',
            role: 'ado-ci',
            expiresIn: '90d',
        });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        assertMasked(stdout);

        const post = requests.find((r) => r.method === 'POST');
        const body = JSON.parse(post!.body) as { expiresIn: unknown; id: unknown };
        expect(body.expiresIn).toBe(7776000);
        expect(typeof body.expiresIn).toBe('number');
        // The id is generated client-side, because the response never returns one.
        expect(typeof body.id).toBe('string');
        expect(outputVariable(stdout, 'tokenId')).toBe(body.id);
    });

    it('warns when a token would never expire', async () => {
        scenario = {};
        const { stdout } = await run('ArgoCDProjectV1', {
            command: 'create-token',
            project: 'payments',
            role: 'ado-ci',
            expiresIn: '0',
        });
        expect(stdout).toContain('##vso[task.issue type=warning;');
        expect(stdout).toContain('NEVER EXPIRE');
    });

    it('rejects an unparseable lifetime rather than minting a permanent token', async () => {
        scenario = {};
        const { stdout } = await run('ArgoCDProjectV1', {
            command: 'create-token',
            project: 'payments',
            role: 'ado-ci',
            expiresIn: '90 days',
        });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('not a valid duration');
        expect(requests.some((r) => r.method === 'POST')).toBe(false);
    });

    it('lists token ids on a role', async () => {
        scenario = { projectTokens: ['id-one', 'id-two'] };
        const { stdout } = await run('ArgoCDProjectV1', {
            command: 'list-tokens',
            project: 'payments',
            role: 'ado-ci',
        });
        expect(outputVariable(stdout, 'tokenCount')).toBe('2');
        expect(outputVariable(stdout, 'tokenIds')).toBe('id-one,id-two');
    });

    it('names the available roles when the role does not exist', async () => {
        scenario = { roleName: 'someone-else' };
        const { stdout } = await run('ArgoCDProjectV1', {
            command: 'list-tokens',
            project: 'payments',
            role: 'ado-ci',
        });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('Available roles: someone-else');
    });

    it('deletes a token and confirms it is gone', async () => {
        scenario = { projectTokens: ['doomed', 'keeper'] };
        const { stdout } = await run('ArgoCDProjectV1', {
            command: 'delete-token',
            project: 'payments',
            role: 'ado-ci',
            tokenId: 'doomed',
        });
        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(outputVariable(stdout, 'tokenCount')).toBe('1');
    });

    it('FAILS when the server reports success but deleted nothing', async () => {
        // The real endpoint returns 200 for a wrong role or a missing id, so trusting the
        // status code would report a revocation that never happened.
        scenario = { projectTokens: ['stubborn'], deleteDoesNothing: true };
        const { stdout } = await run('ArgoCDProjectV1', {
            command: 'delete-token',
            project: 'payments',
            role: 'ado-ci',
            tokenId: 'stubborn',
        });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('still present');
    });

    it('requires the inputs each command needs', async () => {
        scenario = {};
        const { stdout } = await run('ArgoCDProjectV1', { command: 'create-token', project: 'payments' });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('"role" input is required');
    });
});

describe('ArgoCDAccount', () => {
    it('lists accounts', async () => {
        scenario = {};
        const { stdout } = await run('ArgoCDAccountV1', { command: 'list' });
        expect(outputVariable(stdout, 'accountCount')).toBe('1');
    });

    it('mints and masks an account token', async () => {
        scenario = {};
        const { stdout } = await run('ArgoCDAccountV1', {
            command: 'create-token',
            account: 'ado-ci',
            expiresIn: '12h',
        });
        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        assertMasked(stdout);
        expect(JSON.parse(requests.find((r) => r.method === 'POST')!.body).expiresIn).toBe(43200);
    });

    it('warns when an account cannot hold tokens', async () => {
        scenario = { accountCapabilities: ['login'] };
        const { stdout } = await run('ArgoCDAccountV1', { command: 'get', account: 'ado-ci' });
        expect(stdout).toContain('##vso[task.issue type=warning;');
        expect(stdout).toContain('apiKey capability');
    });

    it('deletes an account token', async () => {
        scenario = { accountTokens: ['gone', 'stays'] };
        const { stdout } = await run('ArgoCDAccountV1', {
            command: 'delete-token',
            account: 'ado-ci',
            tokenId: 'gone',
        });
        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(outputVariable(stdout, 'tokenCount')).toBe('1');
    });

    it('builds a multi-segment subresource as real path segments', async () => {
        // Percent-encoding the slash breaks the route, because the subresource is a
        // multi-segment wildcard.
        scenario = { canIValue: 'yes' };
        const { stdout } = await run('ArgoCDAccountV1', {
            command: 'can-i',
            resource: 'applications',
            action: 'sync',
            subresource: 'payments/payments-api',
        });

        expect(outputVariable(stdout, 'allowed')).toBe('true');
        const call = requests[requests.length - 1];
        expect(call?.url).toBe('/api/v1/account/can-i/applications/sync/payments/payments-api');
        expect(call?.url).not.toContain('%2F');
    });

    it('reads "no" as denied without failing by default', async () => {
        scenario = { canIValue: 'no' };
        const { stdout } = await run('ArgoCDAccountV1', {
            command: 'can-i',
            resource: 'applications',
            action: 'delete',
            subresource: 'payments/*',
        });
        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(outputVariable(stdout, 'allowed')).toBe('false');
    });

    it('fails on denial when asked to', async () => {
        scenario = { canIValue: 'no' };
        const { stdout } = await run('ArgoCDAccountV1', {
            command: 'can-i',
            resource: 'applications',
            action: 'delete',
            subresource: 'payments/*',
            failIfDenied: 'true',
        });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('not permitted to delete');
    });

    it('omits the subresource when none is given', async () => {
        scenario = {};
        await run('ArgoCDAccountV1', { command: 'can-i', resource: 'projects', action: 'get' });
        expect(requests[requests.length - 1]?.url).toBe('/api/v1/account/can-i/projects/get');
    });
});
