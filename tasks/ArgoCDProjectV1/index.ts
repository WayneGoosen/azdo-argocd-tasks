// ArgoCDProject@1 -- read projects and manage project role tokens.
//
// This task exists mainly to solve the problem the rest of the extension creates: the Argo
// CD token in a service connection expires, and something has to mint and revoke its
// replacement. See docs/token-rotation.md for the full rotation flow.
//
// Two server behaviours shape the code here:
//
//   * NEITHER token-creation endpoint RETURNS THE TOKEN ID. The response carries the JWT
//     and nothing else. Rather than decoding the JWT (which is what the CLI does), this
//     task generates a UUID and sends it as the id, so the revocation handle is known.
//
//   * DELETING A TOKEN SILENTLY SUCCEEDS. A wrong role name or a non-existent id both
//     return HTTP 200 with an empty body. So the task re-reads the project afterwards and
//     confirms the id is actually gone, rather than reporting a success that never happened.

import * as tl from 'azure-pipelines-task-lib/task';
import { ArgoCdClient, JWTToken, createNodeHttpsTransport } from '@azdo-argocd/argocd-client';
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

type Command = 'get' | 'list' | 'create-token' | 'delete-token' | 'list-tokens';

const VALID_COMMANDS: readonly Command[] = ['get', 'list', 'create-token', 'delete-token', 'list-tokens'];

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
            userAgent: `azdo-argocd-tasks/ArgoCDProject@1 (${tl.getVariable('Agent.OS') ?? 'unknown'})`,
        });

        switch (command) {
            case 'list':
                await runList(client);
                break;
            case 'get':
                await runGet(client);
                break;
            case 'list-tokens':
                await runListTokens(client);
                break;
            case 'create-token':
                await runCreateToken(client);
                break;
            case 'delete-token':
                await runDeleteToken(client);
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
    const projects = (await client.listProjects()).items ?? [];
    for (const project of projects) {
        console.log(`  ${project.metadata?.name ?? '?'}`);
    }
    setOutput('projectCount', String(projects.length));
    tl.setResult(tl.TaskResult.Succeeded, `Found ${projects.length} project(s)`);
}

async function runGet(client: ArgoCdClient): Promise<void> {
    const name = requiredInput('project', 'get');
    const project = await client.getProject(name);
    const roles = project.spec?.roles ?? [];

    console.log(`Project ${name}`);
    console.log(`  description: ${project.spec?.description ?? '-'}`);
    console.log(`  source repos: ${(project.spec?.sourceRepos ?? []).join(', ') || '-'}`);
    console.log(`  roles: ${roles.length}`);
    for (const role of roles) {
        console.log(`    ${role.name ?? '?'} (${(role.jwtTokens ?? []).length} token(s))`);
        for (const policy of role.policies ?? []) {
            console.log(`      ${policy}`);
        }
    }

    setOutput('roleCount', String(roles.length));
    tl.setResult(tl.TaskResult.Succeeded, `Read project ${name}`);
}

/** Token metadata lives on the project; there is no list-tokens endpoint. */
async function findRoleTokens(client: ArgoCdClient, project: string, role: string): Promise<JWTToken[]> {
    const fetched = await client.getProject(project);
    const roles = fetched.spec?.roles ?? [];
    const match = roles.find((entry) => entry.name === role);
    if (match === undefined) {
        const available = roles.map((entry) => entry.name).filter(Boolean).join(', ');
        throw new Error(
            `Project "${project}" has no role "${role}". Available roles: ${available || 'none'}.`,
        );
    }
    return match.jwtTokens ?? [];
}

async function runListTokens(client: ArgoCdClient): Promise<void> {
    const project = requiredInput('project', 'list-tokens');
    const role = requiredInput('role', 'list-tokens');
    const tokens = await findRoleTokens(client, project, role);

    console.log(`Role ${project}:${role} has ${tokens.length} token(s)`);
    for (const token of tokens) {
        console.log(`  ${token.id ?? '?'}  issued ${describeExpiry(token.iat)}  expires ${describeExpiry(token.exp)}`);
    }

    setOutput('tokenCount', String(tokens.length));
    setOutput('tokenIds', tokens.map((token) => token.id ?? '').filter(Boolean).join(','));
    tl.setResult(tl.TaskResult.Succeeded, `Role ${role} has ${tokens.length} token(s)`);
}

async function runCreateToken(client: ArgoCdClient): Promise<void> {
    const project = requiredInput('project', 'create-token');
    const role = requiredInput('role', 'create-token');
    const expiresInSeconds = parseDurationSeconds(tl.getInput('expiresIn', false) ?? '90d');

    if (expiresInSeconds === 0) {
        tl.warning(
            'This token will NEVER EXPIRE. A non-expiring credential in a pipeline is hard to ' +
                'account for; prefer a bounded lifetime such as 90d together with a rotation pipeline.',
        );
    }

    // The response carries only the token, so supply the id rather than decoding the JWT.
    const id = newTokenId();
    console.log(`Creating token for ${project}:${role} (${describeDurationSeconds(expiresInSeconds)})`);

    const response = await client.createProjectToken(project, role, { expiresInSeconds, id });
    const token = response.token;
    if (token === undefined || token === '') {
        throw new Error('Argo CD returned an empty token.');
    }

    // Mask before anything else can print it.
    registerSecret(token);
    setOutput('token', token, true);
    setOutput('tokenId', id);

    console.log(`Token created with id ${id}.`);
    console.log(
        'The token value is only retrievable now -- Argo CD does not store it. It has been ' +
            'published as a secret output variable.',
    );
    tl.setResult(tl.TaskResult.Succeeded, `Created token ${id} for ${project}:${role}`);
}

async function runDeleteToken(client: ArgoCdClient): Promise<void> {
    const project = requiredInput('project', 'delete-token');
    const role = requiredInput('role', 'delete-token');
    const id = requiredInput('tokenId', 'delete-token');

    console.log(`Deleting token ${id} from ${project}:${role}...`);
    await client.deleteProjectToken(project, role, id);

    // The API returns 200 whether or not it deleted anything, so confirm rather than trust.
    const remaining = await findRoleTokens(client, project, role);
    if (remaining.some((token) => token.id === id)) {
        throw new Error(
            `Argo CD reported success but token ${id} is still present on ${project}:${role}. ` +
                'This endpoint returns 200 even when it deletes nothing, so the id may be wrong.',
        );
    }

    setOutput('tokenCount', String(remaining.length));
    console.log(`Token ${id} is gone. ${remaining.length} token(s) remain on this role.`);
    tl.setResult(tl.TaskResult.Succeeded, `Deleted token ${id}`);
}

void run();
