// End-to-end test of the shipped ArgoCDCli artifact.
//
// The whole reason this task exists rather than a `script:` step is how it handles the
// token, so that is what these tests pin down: a stub `argocd` on PATH records its argv and
// environment, and the assertions check the token reaches the process environment and never
// the command line.

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureBuilt, outputVariable, runTask } from '../support/run-task';

const TOKEN = 'cli-secret-token-value';
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

let stubDir: string;
let recordPath: string;

interface Recorded {
    argv: string[];
    server: string;
    token: string;
    configDir: string;
    opts: string;
    cwd: string;
}

beforeAll(() => {
    ensureBuilt();
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argocd-stub-'));
    recordPath = path.join(stubDir, 'record.json');

    // Records what it was handed, then behaves as the test asks.
    const stub = `#!/bin/sh
cat > "${recordPath}" <<EOF
{
  "argv": [$(for a in "$@"; do printf '"%s",' "$a"; done | sed 's/,$//')],
  "server": "\${ARGOCD_SERVER:-}",
  "token": "\${ARGOCD_AUTH_TOKEN:-}",
  "configDir": "\${ARGOCD_CONFIG_DIR:-}",
  "opts": "\${ARGOCD_OPTS:-}",
  "cwd": "$(pwd)"
}
EOF
if [ -n "\${STUB_STDERR:-}" ]; then echo "\$STUB_STDERR" >&2; fi
echo "stub argocd ran"
exit \${STUB_EXIT_CODE:-0}
`;
    const stubPath = path.join(stubDir, 'argocd');
    fs.writeFileSync(stubPath, stub, { mode: 0o755 });
});

async function runCli(
    inputs: Record<string, string>,
    options: { data?: Record<string, string>; env?: Record<string, string> } = {},
): Promise<{ stdout: string; exitCode: number }> {
    if (fs.existsSync(recordPath)) {
        fs.unlinkSync(recordPath);
    }
    return runTask({
        task: 'ArgoCDCliV1',
        inputs,
        endpoint: {
            url: 'https://argocd.example.com',
            token: TOKEN,
            ...(options.data === undefined ? {} : { data: options.data }),
        },
        env: { PATH: `${stubDir}:${process.env['PATH'] ?? ''}`, ...(options.env ?? {}) },
    });
}

function recorded(): Recorded {
    return JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Recorded;
}

describeOnPosix('bundled ArgoCDCli task', () => {
    it('runs the command and reports success', async () => {
        const { stdout } = await runCli({ arguments: 'app list' });
        expect(stdout).toContain('##vso[task.complete result=Succeeded');
        expect(stdout).toContain('stub argocd ran');
        expect(outputVariable(stdout, 'argocdExitCode')).toBe('0');
        expect(recorded().argv).toEqual(['app', 'list']);
    });

    it('passes the token in the environment and NEVER in argv', async () => {
        const { stdout } = await runCli({ arguments: 'app list' });
        const record = recorded();

        expect(record.token).toBe(TOKEN);
        expect(record.argv.join(' ')).not.toContain(TOKEN);
        expect(record.argv).not.toContain('--auth-token');

        // And it must be masked in the log, before anything could print it.
        expect(stdout).toContain(`##vso[task.setsecret]${TOKEN}`);
        const afterMask = stdout.slice(stdout.indexOf(`##vso[task.setsecret]${TOKEN}`) + TOKEN.length);
        expect(afterMask).not.toContain(TOKEN);
    });

    it('strips the scheme from ARGOCD_SERVER', async () => {
        await runCli({ arguments: 'app list' });
        expect(recorded().server).toBe('argocd.example.com');
    });

    it('never sets ARGOCD_OPTS, which is parsed during CLI init', async () => {
        await runCli({ arguments: 'app list' });
        expect(recorded().opts).toBe('');
    });

    it('isolates the CLI config directory and removes it afterwards', async () => {
        await runCli({ arguments: 'app list' });
        const { configDir } = recorded();
        expect(configDir).not.toBe('');
        // Cleaned up in finally, so a session file cannot leak into the next step.
        expect(fs.existsSync(configDir)).toBe(false);
    });

    it('folds a multiline argument block into one invocation', async () => {
        await runCli({ arguments: '# deploy it\napp sync payments\n  --prune' });
        expect(recorded().argv).toEqual(['app', 'sync', 'payments', '--prune']);
    });

    it('passes connection settings as argv flags', async () => {
        await runCli({ arguments: 'app list', grpcWeb: 'true' }, {
            data: { insecureSkipTlsVerify: 'true', grpcWebRootPath: '/argocd' },
        });
        const { argv } = recorded();
        expect(argv).toContain('--insecure');
        expect(argv).toContain('--grpc-web');
        // Flag and value as separate entries, never `--flag=value`.
        expect(argv).toContain('--grpc-web-root-path');
        expect(argv[argv.indexOf('--grpc-web-root-path') + 1]).toBe('/argocd');
    });

    it('writes a custom CA to disk and points --server-crt at it', async () => {
        await runCli({ arguments: 'app list' }, { data: { caCertificate: '-----BEGIN CERTIFICATE-----\nx\n' } });
        const { argv } = recorded();
        expect(argv).toContain('--server-crt');
        const caPath = argv[argv.indexOf('--server-crt') + 1] as string;
        // Removed with the rest of the scratch directory.
        expect(fs.existsSync(caPath)).toBe(false);
    });

    it('fails on a non-zero exit code by default', async () => {
        const { stdout } = await runCli({ arguments: 'app get missing' }, { env: { STUB_EXIT_CODE: '13' } });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('exited with code 13');
        expect(outputVariable(stdout, 'argocdExitCode')).toBe('13');
    });

    it('reports succeeded-with-issues when failOnNonZeroExit is off', async () => {
        const { stdout } = await runCli(
            { arguments: 'app get missing', failOnNonZeroExit: 'false' },
            { env: { STUB_EXIT_CODE: '13' } },
        );
        expect(stdout).toContain('##vso[task.complete result=SucceededWithIssues');
        expect(outputVariable(stdout, 'argocdExitCode')).toBe('13');
    });

    it('tolerates stderr output by default, since argocd writes progress there', async () => {
        const { stdout } = await runCli({ arguments: 'app list' }, { env: { STUB_STDERR: 'a warning' } });
        expect(stdout).toContain('##vso[task.complete result=Succeeded');
    });

    it('rejects a leading "argocd", naming the fix', async () => {
        const { stdout } = await runCli({ arguments: 'argocd app list' });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('Remove the leading "argocd"');
        expect(stdout).toContain('"app list"');
    });

    it('rejects empty arguments', async () => {
        const { stdout } = await runCli({ arguments: '   \n # only a comment\n' });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('No arguments were supplied');
    });

    it('points at ArgoCDInstall when the CLI is missing from PATH', async () => {
        const { stdout } = await runTask({
            task: 'ArgoCDCliV1',
            inputs: { arguments: 'app list' },
            endpoint: { url: 'https://argocd.example.com', token: TOKEN },
            env: { PATH: '/nonexistent-path-for-this-test' },
        });
        expect(stdout).toContain('##vso[task.complete result=Failed');
        expect(stdout).toContain('ArgoCDInstall@1');
    });
});
