// Shared harness for running a BUNDLED task the way the agent does.
//
// The unit tests import TypeScript sources directly, so they cannot catch the failures that
// only appear after bundling: a split azure-pipelines-task-lib copy, an unresolved runtime
// require, or a __dirname-relative read that breaks once the tree is flattened. This runs
// dist/tasks/<Task>/index.js in a child process with the same INPUT_* / ENDPOINT_*
// environment an agent provides.
//
// Env var shapes are dictated by task-lib: INPUT_* and ENDPOINT_AUTH_* are read at module
// load into its vault, while ENDPOINT_URL_* and ENDPOINT_DATA_* are read straight from the
// environment.

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const REPO_ROOT = path.join(__dirname, '..', '..');
export const DEFAULT_CONNECTION_ID = 'conn1';

export interface EndpointSpec {
    id?: string;
    url: string;
    token?: string | undefined;
    /** Endpoint data parameters, e.g. caCertificate, insecureSkipTlsVerify, grpcWebRootPath. */
    data?: Record<string, string>;
}

export interface TaskRunOptions {
    /** Task directory name, e.g. "ArgoCDAppV1". */
    task: string;
    inputs: Record<string, string>;
    endpoint?: EndpointSpec | undefined;
    /** Extra environment for the child, e.g. PATH or AGENT_TOOLSDIRECTORY. */
    env?: Record<string, string>;
}

export interface TaskRunResult {
    stdout: string;
    exitCode: number;
    tempDirectory: string;
}

export function bundlePath(task: string): string {
    return path.join(REPO_ROOT, 'dist', 'tasks', task, 'index.js');
}

/** Newest mtime under a directory tree, ignoring build output. */
function newestMtime(directory: string): number {
    if (!fs.existsSync(directory)) {
        return 0;
    }
    let newest = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') {
            continue;
        }
        const full = path.join(directory, entry.name);
        newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs);
    }
    return newest;
}

/**
 * Build on demand, and REBUILD when sources are newer than the bundle.
 *
 * Checking only for existence is a trap: after editing a source file the suite would keep
 * exercising a stale artifact and report passes (or baffling failures) that have nothing to
 * do with the current code.
 */
export function ensureBuilt(): void {
    const bundle = bundlePath('ArgoCDAppV1');
    if (fs.existsSync(bundle)) {
        const built = fs.statSync(bundle).mtimeMs;
        const sources = Math.max(
            newestMtime(path.join(REPO_ROOT, 'packages')),
            newestMtime(path.join(REPO_ROOT, 'tasks')),
            fs.statSync(path.join(REPO_ROOT, 'scripts', 'build.mjs')).mtimeMs,
        );
        if (built >= sources) {
            return;
        }
    }
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'build.mjs')], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
    });
}

export function runTask(options: TaskRunOptions): Promise<TaskRunResult> {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'argocd-task-'));
    const connectionId = options.endpoint?.id ?? DEFAULT_CONNECTION_ID;

    const env: NodeJS.ProcessEnv = {
        PATH: process.env['PATH'] ?? '',
        // A real agent always provides these. The argocd CLI in particular exits with
        // `$HOME is not defined` without HOME, which surfaced only in CI because the
        // local shell happened to inherit it.
        HOME: process.env['HOME'] ?? tempDirectory,
        USER: process.env['USER'] ?? 'runner',
        AGENT_TEMPDIRECTORY: tempDirectory,
        AGENT_OS: 'Linux',
        ...Object.fromEntries(
            Object.entries(options.inputs).map(([key, value]) => [`INPUT_${key.toUpperCase()}`, value]),
        ),
        ...(options.env ?? {}),
    };

    if (options.endpoint !== undefined) {
        env[`ENDPOINT_URL_${connectionId}`] = options.endpoint.url;
        env['INPUT_CONNECTION'] = connectionId;
        if (options.endpoint.token !== undefined) {
            env[`ENDPOINT_AUTH_SCHEME_${connectionId}`] = 'Token';
            env[`ENDPOINT_AUTH_PARAMETER_${connectionId}_APITOKEN`] = options.endpoint.token;
        } else {
            env[`ENDPOINT_AUTH_SCHEME_${connectionId}`] = 'None';
        }
        for (const [key, value] of Object.entries(options.endpoint.data ?? {})) {
            env[`ENDPOINT_DATA_${connectionId}_${key.toUpperCase()}`] = value;
        }
    }

    return new Promise((resolve) => {
        const child = spawn(process.execPath, [bundlePath(options.task)], { env, cwd: REPO_ROOT });
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.on('close', (code) => resolve({ stdout, exitCode: code ?? 0, tempDirectory }));
    });
}

/** Pull the path out of a `##vso[task.uploadsummary]` line. */
export function summaryPathFrom(stdout: string): string | undefined {
    const line = stdout.split('\n').find((l) => l.includes('##vso[task.uploadsummary]'));
    return line?.split('##vso[task.uploadsummary]')[1]?.trim();
}

/** Read an output variable from the emitted logging commands. */
export function outputVariable(stdout: string, name: string): string | undefined {
    const marker = `##vso[task.setvariable variable=${name};isOutput=true;issecret=false;]`;
    const line = stdout.split('\n').find((l) => l.includes(marker));
    return line?.split(marker)[1]?.trim();
}
