// ArgoCDCli@1 -- run any argocd command with authentication injected.
//
// This is the escape hatch. The REST tasks cover what most pipelines need, but `app diff
// --local`, `--core` mode, `admin` subcommands and brand-new Argo CD features have no REST
// equivalent, and users should never be blocked on this extension's roadmap.
//
// The reason this exists rather than a plain `script:` step is entirely about the token:
//
//   * It is placed ONLY in the child process's environment. Microsoft is explicit that
//     secrets must never be passed on a command line, because some operating systems log
//     argv. It is also never exported as a pipeline variable, which would make it readable
//     by every later step in the job -- the behaviour of the existing Marketplace installer
//     that this deliberately avoids.
//   * Connection settings become argv flags rather than ARGOCD_OPTS. ARGOCD_OPTS is parsed
//     during CLI init(), and a value its shell-quote splitter cannot handle aborts the
//     process before the command runs.
//   * The CLI config directory is per-step and deleted afterwards, so a cached session
//     cannot leak between steps or jobs.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tl from 'azure-pipelines-task-lib/task';
import { cliEnvironment, cliGlobalFlags, foldArguments } from '@azdo-argocd/cli-runner';
import {
    describeError,
    getBoolInputOrDefault,
    readArgoCdEndpoint,
    setOutput,
} from '@azdo-argocd/task-common';

const STEP_PREFIX = 'argocd-cli';

async function run(): Promise<void> {
    let scratchDirectory: string | undefined;

    try {
        const endpoint = readArgoCdEndpoint('connection');

        const rawArguments = tl.getInput('arguments', true) ?? '';
        const argumentLine = foldArguments(rawArguments);
        if (argumentLine === '') {
            throw new Error(
                'No arguments were supplied. Give the task the argocd arguments to run, for ' +
                    'example "app list". Do not include the "argocd" command itself.',
            );
        }
        if (/^argocd(\s|$)/i.test(argumentLine)) {
            throw new Error(
                `Remove the leading "argocd" from the arguments -- the task supplies it. ` +
                    `Use "${argumentLine.replace(/^argocd\s*/i, '')}" instead.`,
            );
        }

        const toolPath = tl.which('argocd', false);
        if (toolPath === undefined || toolPath === '') {
            throw new Error(
                'The argocd CLI was not found on PATH. Add an ArgoCDInstall@1 step before this one, ' +
                    'or install the CLI on the agent yourself.',
            );
        }

        scratchDirectory = makeScratchDirectory();
        const configDir = path.join(scratchDirectory, 'config');
        fs.mkdirSync(configDir, { recursive: true });

        // The CLI wants a CA on disk; the service connection carries it as PEM text.
        let caCertPath: string | undefined;
        if (endpoint.caCertificate !== undefined && endpoint.caCertificate.trim() !== '') {
            caCertPath = path.join(scratchDirectory, 'ca.pem');
            fs.writeFileSync(caCertPath, endpoint.caCertificate, { mode: 0o600 });
        }

        const globalFlags = cliGlobalFlags(endpoint, {
            caCertPath,
            grpcWeb: tl.getBoolInput('grpcWeb', false),
        });

        const runner = tl.tool(toolPath);
        runner.line(argumentLine);
        for (const flag of globalFlags) {
            runner.arg(flag);
        }

        const childEnvironment = {
            ...process.env,
            ...cliEnvironment(endpoint, { configDir }),
        } as { [key: string]: string };

        const workingDirectory = tl.getPathInput('workingDirectory', false, true);
        const exitCode = await runner.exec({
            cwd: workingDirectory,
            env: childEnvironment,
            failOnStdErr: tl.getBoolInput('failOnStderr', false),
            ignoreReturnCode: true,
            silent: false,
            errStream: process.stderr,
            outStream: process.stdout,
            windowsVerbatimArguments: false,
        });

        setOutput('argocdExitCode', String(exitCode));

        if (exitCode !== 0 && getBoolInputOrDefault('failOnNonZeroExit', true)) {
            tl.setResult(tl.TaskResult.Failed, `argocd exited with code ${exitCode}`);
            return;
        }
        if (exitCode !== 0) {
            tl.setResult(
                tl.TaskResult.SucceededWithIssues,
                `argocd exited with code ${exitCode} (failOnNonZeroExit is off)`,
            );
            return;
        }

        tl.setResult(tl.TaskResult.Succeeded, 'argocd completed successfully');
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, describeError(error));
    } finally {
        cleanUp(scratchDirectory);
    }
}

function makeScratchDirectory(): string {
    const base = tl.getVariable('Agent.TempDirectory') ?? os.tmpdir();
    return fs.mkdtempSync(path.join(base, `${STEP_PREFIX}-`));
}

/**
 * Remove the CLI config and any CA file.
 * Runs in `finally` so a failed command cannot leave a session file behind for the next step.
 */
function cleanUp(directory: string | undefined): void {
    if (directory === undefined) {
        return;
    }
    try {
        fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
        tl.warning(`Could not remove the temporary Argo CD CLI config at ${directory}: ${describeError(error)}`);
    }
}

void run();
