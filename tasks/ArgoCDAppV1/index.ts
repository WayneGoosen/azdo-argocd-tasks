// ArgoCDApp@1 -- entry point.
//
// Owns every side effect: reading inputs, masking the token, emitting output variables,
// publishing the summary and setting the task result. The command implementations in
// operations.ts stay pure enough to test without an agent.
//
// House rule, same as the rest of this repo: validate, then setResult(Failed), then
// return. run() never throws.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tl from 'azure-pipelines-task-lib/task';
import { ArgoCdClient, createNodeHttpsTransport } from '@azdo-argocd/argocd-client';
import {
    AppSnapshot,
    Decision,
    OutputNames,
    applicationUrl,
    describeError,
    readArgoCdEndpoint,
    setOutput,
    uploadSummary,
} from '@azdo-argocd/task-common';
import { getCommonInputs, getRefreshType, getWaitInputs } from './inputs';
import {
    OperationContext,
    runAction,
    runCreate,
    runDelete,
    runDiff,
    runGet,
    runHistory,
    runLogs,
    runManifests,
    runRollback,
    runSpecEdit,
    runSync,
    runTerminate,
    runWait,
} from './operations/index';

const SUMMARY_DIRECTORY = 'argocd-tasks';

async function run(): Promise<void> {
    try {
        const endpoint = readArgoCdEndpoint('connection');
        const common = getCommonInputs();

        const client = new ArgoCdClient({
            serverUrl: endpoint.url,
            token: endpoint.token,
            transport: createNodeHttpsTransport({
                caCertificate: endpoint.caCertificate,
                insecureSkipTlsVerify: endpoint.insecureSkipTlsVerify,
            }),
            userAgent: `azdo-argocd-tasks/ArgoCDApp@1 (${tl.getVariable('Agent.OS') ?? 'unknown'})`,
        });

        if (common.project === undefined) {
            // Worth a warning: without a project, Argo CD deliberately answers "permission
            // denied" for a missing application as well as for a real RBAC failure, which
            // makes a simple typo look like a broken token.
            tl.warning(
                'No "project" was supplied. Argo CD cannot then distinguish a missing application ' +
                    'from one you may not see, and both surface as "permission denied". ' +
                    'Set "project" to get accurate errors.',
            );
        }

        const ctx: OperationContext = { client, serverUrl: endpoint.url, common };
        const outcome = await dispatch(ctx);

        publishOutputs(outcome.snapshots, endpoint.url, outcome.extraOutputs);

        if (common.publishSummary && outcome.summary !== undefined && outcome.summary !== '') {
            writeSummary(outcome.summary, common.command);
        }

        applyResult(outcome.decision);
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, describeError(error));
    }
}

async function dispatch(ctx: OperationContext): Promise<{
    decision: Decision;
    snapshots: AppSnapshot[];
    summary: string | undefined;
    extraOutputs: Record<string, string>;
}> {
    switch (ctx.common.command) {
        case 'get':
            return runGet(ctx, getRefreshType('refresh'));
        case 'refresh':
            // `refresh` is `get` that always refreshes; hard refresh re-runs manifest generation.
            return runGet(ctx, tl.getBoolInput('hard', false) ? 'hard' : 'normal');
        case 'sync':
            return runSync(ctx, getWaitInputs());
        case 'wait':
            return runWait(ctx, getWaitInputs());
        case 'diff':
            return runDiff(ctx);
        case 'history':
            return runHistory(ctx);
        case 'rollback':
            return runRollback(ctx, getWaitInputs());
        case 'action':
            return runAction(ctx);
        case 'manifests':
            return runManifests(ctx);
        case 'logs':
            return runLogs(ctx);
        case 'terminate':
            return runTerminate(ctx);
        case 'create':
            return runCreate(ctx);
        case 'set':
            return runSpecEdit(ctx, 'set');
        case 'unset':
            return runSpecEdit(ctx, 'unset');
        case 'delete':
            return runDelete(ctx);
        default:
            throw new Error(`Unhandled command "${ctx.common.command as string}".`);
    }
}

function publishOutputs(
    snapshots: readonly AppSnapshot[],
    serverUrl: string,
    extra: Record<string, string>,
): void {
    // Scalar outputs only make sense for a single application; a multi-app run would
    // otherwise silently publish whichever app happened to sort first.
    const single = snapshots.length === 1 ? snapshots[0] : undefined;
    if (single !== undefined) {
        setOutput(OutputNames.SYNC_STATUS, single.syncStatus ?? 'Unknown');
        setOutput(OutputNames.HEALTH_STATUS, single.healthStatus ?? 'Unknown');
        setOutput(OutputNames.REVISION, single.revision ?? '');
        // A multi-source app has one revision per source, of differing kinds -- a Helm chart
        // version alongside a git SHA. Joined into `revision` they cannot be told apart, so
        // the list is published too.
        setOutput(OutputNames.REVISIONS, JSON.stringify(single.revisions ?? []));
        setOutput(OutputNames.OPERATION_PHASE, single.operationPhase ?? '');
        setOutput(OutputNames.OPERATION_MESSAGE, single.operationMessage ?? '');
        setOutput(OutputNames.APP_URL, applicationUrl(serverUrl, single.name, single.namespace));
    }

    setOutput(OutputNames.APPS_JSON, JSON.stringify(snapshots));
    for (const [name, value] of Object.entries(extra)) {
        setOutput(name, value);
    }
}

function writeSummary(markdown: string, command: string): void {
    try {
        const directory = path.join(tl.getVariable('Agent.TempDirectory') ?? '.', SUMMARY_DIRECTORY);
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `argocd-${command}-${Date.now()}.md`);
        fs.writeFileSync(file, markdown, 'utf8');
        uploadSummary(file, `Argo CD ${command}`);
    } catch (error) {
        // A summary is a nicety. It must never fail a deployment that worked.
        tl.warning(`Could not write the Argo CD summary: ${describeError(error)}`);
    }
}

function applyResult(decision: Decision): void {
    switch (decision.verdict) {
        case 'succeeded':
            tl.setResult(tl.TaskResult.Succeeded, decision.message);
            return;
        case 'succeededWithIssues':
            tl.setResult(tl.TaskResult.SucceededWithIssues, decision.message);
            return;
        default:
            tl.setResult(tl.TaskResult.Failed, decision.message);
    }
}

void run();
