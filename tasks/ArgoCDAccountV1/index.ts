// ArgoCDAccount@1 -- local account tokens and permission checks.
//
// Local account tokens are the credential to reach for when a pipeline must cross project
// boundaries; a project role token is preferable whenever one project is enough, because
// its blast radius is that project alone. See docs/security.md.
//
// `can-i` is the quietly useful command here: a pipeline can assert it holds the
// permissions it needs before it starts changing anything, rather than failing halfway.
//
// Unlike the project side, account token metadata IS readable -- GET /api/v1/account/{name}
// lists ids, issued and expiry times. Note those use the LONG field names
// (issuedAt/expiresAt) where the project side uses iat/exp.

import * as tl from 'azure-pipelines-task-lib/task';
import { ArgoCdClient, createNodeHttpsTransport } from '@azdo-argocd/argocd-client';
import {
    describeDurationSeconds,
    describeError,
    describeExpiry,
    newTokenId,
    parseDurationSeconds,
    readArgoCdEndpoint,
    registerSecret,
    setOutput,
} from '@azdo-argocd/task-common';

type Command = 'list' | 'get' | 'create-token' | 'delete-token' | 'can-i';

const VALID_COMMANDS: readonly Command[] = ['list', 'get', 'create-token', 'delete-token', 'can-i'];

async function run(): Promise<void> {
    try {
        const endpoint = readArgoCdEndpoint('connection');
        const command = readCommand();

        const client = new ArgoCdClient({
            serverUrl: endpoint.url,
            token: endpoint.token,
            transport: createNodeHttpsTransport({
                caCertificate: endpoint.caCertificate,
                insecureSkipTlsVerify: endpoint.insecureSkipTlsVerify,
            }),
            userAgent: `azdo-argocd-tasks/ArgoCDAccount@1 (${tl.getVariable('Agent.OS') ?? 'unknown'})`,
        });

        switch (command) {
            case 'list':
                await runList(client);
                break;
            case 'get':
                await runGet(client);
                break;
            case 'create-token':
                await runCreateToken(client);
                break;
            case 'delete-token':
                await runDeleteToken(client);
                break;
            case 'can-i':
                await runCanI(client);
                break;
            default:
                throw new Error(`Unhandled command "${command as string}".`);
        }
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, describeError(error));
    }
}

function readCommand(): Command {
    const raw = (tl.getInput('command', true) ?? '').trim() as Command;
    if (!VALID_COMMANDS.includes(raw)) {
        throw new Error(`Unknown command "${raw}". Expected one of: ${VALID_COMMANDS.join(', ')}.`);
    }
    return raw;
}

function requiredInput(name: string, command: string): string {
    const value = tl.getInput(name, false);
    if (value === undefined || value.trim() === '') {
        throw new Error(`The "${name}" input is required for the ${command} command.`);
    }
    return value.trim();
}

async function runList(client: ArgoCdClient): Promise<void> {
    const accounts = (await client.listAccounts()).items ?? [];
    for (const account of accounts) {
        const capabilities = (account.capabilities ?? []).join(', ') || 'none';
        console.log(
            `  ${account.name ?? '?'}  enabled=${account.enabled ?? false}  capabilities=${capabilities}`,
        );
    }
    setOutput('accountCount', String(accounts.length));
    tl.setResult(tl.TaskResult.Succeeded, `Found ${accounts.length} account(s)`);
}

async function runGet(client: ArgoCdClient): Promise<void> {
    const name = requiredInput('account', 'get');
    const account = await client.getAccount(name);
    const tokens = account.tokens ?? [];

    console.log(`Account ${name}`);
    console.log(`  enabled: ${account.enabled ?? false}`);
    console.log(`  capabilities: ${(account.capabilities ?? []).join(', ') || 'none'}`);
    console.log(`  tokens: ${tokens.length}`);
    for (const token of tokens) {
        console.log(
            `    ${token.id ?? '?'}  issued ${describeExpiry(token.issuedAt)}  expires ${describeExpiry(token.expiresAt)}`,
        );
    }

    if (!(account.capabilities ?? []).includes('apiKey')) {
        tl.warning(
            `Account "${name}" does not have the apiKey capability, so it cannot hold API tokens. ` +
                `Add "accounts.${name}: apiKey" to the argocd-cm ConfigMap.`,
        );
    }

    setOutput('tokenCount', String(tokens.length));
    setOutput('tokenIds', tokens.map((token) => token.id ?? '').filter(Boolean).join(','));
    tl.setResult(tl.TaskResult.Succeeded, `Read account ${name}`);
}

async function runCreateToken(client: ArgoCdClient): Promise<void> {
    const name = requiredInput('account', 'create-token');
    const expiresInSeconds = parseDurationSeconds(tl.getInput('expiresIn', false) ?? '90d');

    if (expiresInSeconds === 0) {
        tl.warning(
            'This token will NEVER EXPIRE. A non-expiring credential in a pipeline is hard to ' +
                'account for; prefer a bounded lifetime such as 90d together with a rotation pipeline.',
        );
    }

    const id = newTokenId();
    console.log(`Creating token for account ${name} (${describeDurationSeconds(expiresInSeconds)})`);

    const response = await client.createAccountToken(name, { expiresInSeconds, id });
    const token = response.token;
    if (token === undefined || token === '') {
        throw new Error('Argo CD returned an empty token.');
    }

    registerSecret(token);
    setOutput('token', token, true);
    setOutput('tokenId', id);

    console.log(`Token created with id ${id}.`);
    console.log(
        'The token value is only retrievable now -- Argo CD does not store it. It has been ' +
            'published as a secret output variable.',
    );
    tl.setResult(tl.TaskResult.Succeeded, `Created token ${id} for account ${name}`);
}

async function runDeleteToken(client: ArgoCdClient): Promise<void> {
    const name = requiredInput('account', 'delete-token');
    const id = requiredInput('tokenId', 'delete-token');

    console.log(`Deleting token ${id} from account ${name}...`);
    // Unlike the project endpoint, this one genuinely reports a missing token.
    await client.deleteAccountToken(name, id);

    const remaining = (await client.getAccount(name)).tokens ?? [];
    setOutput('tokenCount', String(remaining.length));
    console.log(`Token ${id} deleted. ${remaining.length} token(s) remain on this account.`);
    tl.setResult(tl.TaskResult.Succeeded, `Deleted token ${id}`);
}

async function runCanI(client: ArgoCdClient): Promise<void> {
    const resource = requiredInput('resource', 'can-i');
    const action = requiredInput('action', 'can-i');
    // Optional: an absent subresource asks about the resource as a whole.
    const subresource = (tl.getInput('subresource', false) ?? '').trim();

    const allowed = await client.canI(resource, action, subresource);
    const target = subresource === '' ? resource : `${resource}/${subresource}`;

    console.log(`can-i ${action} ${target}: ${allowed ? 'yes' : 'no'}`);
    setOutput('allowed', String(allowed));

    if (!allowed && tl.getBoolInput('failIfDenied', false)) {
        tl.setResult(
            tl.TaskResult.Failed,
            `This token is not permitted to ${action} ${target}. Check the Argo CD RBAC policy.`,
        );
        return;
    }

    tl.setResult(
        tl.TaskResult.Succeeded,
        allowed ? `Permitted to ${action} ${target}` : `Not permitted to ${action} ${target}`,
    );
}

void run();
