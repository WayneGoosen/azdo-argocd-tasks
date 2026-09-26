// End-to-end test of the shipped ArgoCDInstall artifact.
//
// Runs against a local server standing in for both the Argo CD server (/api/version,
// /download/...) and the release mirror (/releases/download/<tag>/<asset>), so nothing here
// touches the network. The mirror is a real feature -- ARGOCD_CLI_MIRROR exists for
// air-gapped agents -- which is what makes the GitHub path testable at all.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureBuilt, outputVariable, runTask } from '../support/run-task';

// The fake "binary" is a shell script so the task's `argocd version --client` smoke test
// actually executes something. Windows agents cannot run it, so the suite is POSIX-only.
const FAKE_BINARY = '#!/bin/sh\necho "argocd: v3.5.3+fake"\n';
const FAKE_DIGEST = crypto.createHash('sha256').update(FAKE_BINARY).digest('hex');
const SERVER_VERSION = 'v3.5.3+abc1234';

interface Scenario {
    /** Serve a corrupted body so the checksum no longer matches. */
    corrupt?: boolean;
    /** Return 404 for the asset, as an unreleased server version would. */
    missingRelease?: boolean;
    serverPlatform?: string;
}

let server: http.Server;
let baseUrl: string;
let scenario: Scenario = {};
let toolsDirectory: string;

const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

beforeAll(async () => {
    ensureBuilt();
    toolsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'argocd-tools-'));

    server = http.createServer((req, res) => {
        const url = req.url ?? '';

        if (url.startsWith('/api/version')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    Version: SERVER_VERSION,
                    Platform: scenario.serverPlatform ?? `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`,
                }),
            );
            return;
        }

        if (url.includes('cli_checksums.txt')) {
            // The checksum always describes the PRISTINE binary, so a corrupted download
            // must be caught by comparison rather than by the server telling us.
            const assets = [
                'argocd-linux-amd64',
                'argocd-linux-arm64',
                'argocd-darwin-amd64',
                'argocd-darwin-arm64',
                'argocd-windows-amd64.exe',
            ];
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(assets.map((a) => `${FAKE_DIGEST}  ${a}`).join('\n'));
            return;
        }

        if (url.includes('/releases/download/') || url.startsWith('/download/')) {
            if (scenario.missingRelease) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }
            const body = scenario.corrupt ? `${FAKE_BINARY}# trailing corruption\n` : FAKE_BINARY;
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': Buffer.byteLength(body),
            });
            res.end(body);
            return;
        }

        res.writeHead(404);
        res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Each run gets a fresh tool cache so a previous test's cache hit cannot mask a failure. */
function freshToolsDirectory(): string {
    return fs.mkdtempSync(path.join(toolsDirectory, 'run-'));
}

async function runInstall(
    inputs: Record<string, string>,
    extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; exitCode: number }> {
    return runTask({
        task: 'ArgoCDInstallV1',
        inputs,
        endpoint: { url: baseUrl, token: 'install-token' },
        env: {
            AGENT_TOOLSDIRECTORY: freshToolsDirectory(),
            ARGOCD_CLI_MIRROR: baseUrl,
            ...extraEnv,
        },
    });
}

describeOnPosix('bundled ArgoCDInstall task', () => {
    beforeAll(() => {
        scenario = {};
    });

    it('downloads, verifies, caches and puts the CLI on PATH', async () => {
        scenario = {};
        const { stdout } = await runInstall({ version: 'v3.5.3', source: 'github', verifyChecksum: 'true' });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(stdout).toContain('checksum OK');
        expect(stdout).toContain('##vso[task.prependpath]');

        const installedPath = outputVariable(stdout, 'argocdPath');
        expect(installedPath).toBeDefined();
        expect(outputVariable(stdout, 'argocdVersion')).toBe('v3.5.3');
        expect(fs.existsSync(installedPath as string)).toBe(true);

        // It must be executable, since tool-lib does no chmod of its own.
        // eslint-disable-next-line no-bitwise
        expect(fs.statSync(installedPath as string).mode & 0o111).toBeGreaterThan(0);
    });

    it('rejects a corrupted download instead of caching a broken binary', async () => {
        scenario = { corrupt: true };
        const { stdout } = await runInstall({ version: 'v3.5.3', source: 'github', verifyChecksum: 'true' });

        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('Checksum mismatch');
        expect(stdout).toContain('corrupted or truncated');
    });

    it('skips verification when asked, and says so', async () => {
        scenario = { corrupt: true };
        const { stdout } = await runInstall({ version: 'v3.5.3', source: 'github', verifyChecksum: 'false' });

        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(stdout).toContain('##vso[task.issue type=warning;');
        expect(stdout).toContain('Checksum verification is disabled');
    });

    it('resolves the version from the Argo CD server, stripping build metadata', async () => {
        scenario = {};
        const { stdout } = await runInstall({ version: 'server', source: 'github', verifyChecksum: 'true' });

        // Server reports v3.5.3+abc1234; the release tag is v3.5.3.
        expect(stdout).toContain('Resolved Argo CD CLI version v3.5.3');
        expect(outputVariable(stdout, 'argocdVersion')).toBe('v3.5.3');
    });

    it('explains a missing release rather than reporting a bare 404', async () => {
        scenario = { missingRelease: true };
        const { stdout } = await runInstall({ version: 'v9.9.9', source: 'github', verifyChecksum: 'true' });

        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('No Argo CD release found for v9.9.9');
        expect(stdout).toContain('Pin an explicit version');
    });

    it('rejects an unparseable version before making any request', async () => {
        scenario = {};
        const { stdout } = await runInstall({ version: 'not-a-version', source: 'github' });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('is not a valid Argo CD version');
    });

    it('refuses source "server" when the server cannot serve this agent', async () => {
        // The server only ever serves its own Linux build for its own architecture.
        scenario = { serverPlatform: 'linux/s390x' };
        const { stdout } = await runInstall({ version: 'server', source: 'server' });

        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('Cannot download from the Argo CD server');
    });

    it('reuses the tool cache on a second run', async () => {
        scenario = {};
        const toolsDir = freshToolsDirectory();
        const first = await runTask({
            task: 'ArgoCDInstallV1',
            inputs: { version: 'v3.5.3', source: 'github', verifyChecksum: 'true' },
            endpoint: { url: baseUrl, token: 't' },
            env: { AGENT_TOOLSDIRECTORY: toolsDir, ARGOCD_CLI_MIRROR: baseUrl },
        });
        expect(first.stdout).toContain('Downloading');

        const second = await runTask({
            task: 'ArgoCDInstallV1',
            inputs: { version: 'v3.5.3', source: 'github', verifyChecksum: 'true' },
            endpoint: { url: baseUrl, token: 't' },
            env: { AGENT_TOOLSDIRECTORY: toolsDir, ARGOCD_CLI_MIRROR: baseUrl },
        });
        expect(second.stdout).toContain('in the tool cache');
        expect(second.stdout).not.toContain('Downloading http');
    });
});
