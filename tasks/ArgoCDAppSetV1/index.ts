// ArgoCDAppSet@1 -- manage ApplicationSets and preview what they generate.
//
// The command worth knowing about is `generate`: it renders the Applications an
// ApplicationSet would produce WITHOUT persisting anything, which makes a pull request
// able to show "this change adds three applications and removes one" before merge.
//
// Two things here are easy to get wrong and are commented where they happen:
//
//   * `create` sends the BARE ApplicationSet with upsert/dryRun as query parameters, while
//     `generate` sends it WRAPPED as {"applicationSet": ...}. The asymmetry is upstream's.
//
//   * `dryRun` and `generate` sound interchangeable and are not. dryRun answers "what would
//     this ApplicationSet own?"; generate answers "what would it produce?".
//
// And one that matters more: DELETING AN APPLICATIONSET DELETES EVERY APPLICATION IT
// GENERATED, and therefore the cluster resources those applications manage, unless
// spec.syncPolicy.preserveResourcesOnDeletion is set. One delete can remove dozens of
// applications, so it carries the same guards as ArgoCDApp's delete and reports what is
// about to happen.

import * as fs from 'node:fs';
import * as tl from 'azure-pipelines-task-lib/task';
import { Application, ApplicationSet, ArgoCdClient, createNodeHttpsTransport } from '@azdo-argocd/argocd-client';
import {
    describeError,
    echoBounded,
    manifestName,
    parseKubernetesManifests,
    readArgoCdEndpoint,
    safeFileName,
    setOutput,
    uploadArtifact,
    writeOutputFile,
} from '@azdo-argocd/task-common';

type Command = 'list' | 'get' | 'create' | 'generate' | 'delete';

const VALID_COMMANDS: readonly Command[] = ['list', 'get', 'create', 'generate', 'delete'];
const APPLICATION_SET_KIND = 'ApplicationSet';
const ECHO_LINE_LIMIT = 60;
/** Generator errors carry a log buffer that can run to thousands of lines. */
const MAX_ERROR_LENGTH = 4000;

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
            userAgent: `azdo-argocd-tasks/ArgoCDAppSet@1 (${tl.getVariable('Agent.OS') ?? 'unknown'})`,
        });

        switch (command) {
            case 'list':
                await runList(client);
                break;
            case 'get':
                await runGet(client);
                break;
            case 'create':
                await runCreate(client);
                break;
            case 'generate':
                await runGenerate(client);
                break;
            case 'delete':
                await runDelete(client);
                break;
            default:
                throw new Error(`Unhandled command "${command as string}".`);
        }
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, truncate(describeError(error)));
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

function appsetNamespace(): string | undefined {
    return tl.getInput('appsetNamespace', false) || undefined;
}

/** Keep a generator's log buffer from swamping the task result message. */
function truncate(message: string): string {
    return message.length <= MAX_ERROR_LENGTH
        ? message
        : `${message.slice(0, MAX_ERROR_LENGTH)}\n... (truncated; see the log above for the full generator output)`;
}

async function runList(client: ArgoCdClient): Promise<void> {
    const projects = tl
        .getDelimitedInput('projects', '\n', false)
        .map((value) => value.trim())
        .filter((value) => value !== '');

    const result = await client.listApplicationSets({
        projects,
        selector: tl.getInput('selector', false) || undefined,
        appsetNamespace: appsetNamespace(),
    });
    const items = result.items ?? [];

    for (const item of items) {
        const generators = (item.spec?.generators ?? []).length;
        console.log(`  ${item.metadata?.name ?? '?'}  (${generators} generator(s))`);
    }

    if (items.length === 0) {
        // Project filtering happens after the RBAC check, so these are indistinguishable.
        console.log(
            'No ApplicationSets matched. Either none exist for this filter, or this token cannot see them.',
        );
    }

    setOutput('appSetCount', String(items.length));
    setOutput('appSetNames', items.map((item) => item.metadata?.name ?? '').filter(Boolean).join(','));
    tl.setResult(tl.TaskResult.Succeeded, `Found ${items.length} ApplicationSet(s)`);
}

async function runGet(client: ArgoCdClient): Promise<void> {
    const name = requiredInput('name', 'get');
    const appset = await client.getApplicationSet(name, { appsetNamespace: appsetNamespace() });

    console.log(`ApplicationSet ${name}`);
    console.log(`  generators: ${(appset.spec?.generators ?? []).length}`);
    console.log(`  preserves resources on deletion: ${preservesResources(appset)}`);

    const resources = appset.status?.resources ?? [];
    console.log(`  generated applications: ${resources.length}`);
    for (const resource of resources) {
        console.log(`    ${resource.name ?? '?'}`);
    }

    for (const condition of appset.status?.conditions ?? []) {
        if (condition.status === 'True' && condition.type !== 'ResourcesUpToDate') {
            console.log(`  condition ${condition.type}: ${condition.message ?? ''}`);
        }
    }

    setOutput('generatedAppCount', String(resources.length));
    tl.setResult(tl.TaskResult.Succeeded, `Read ApplicationSet ${name}`);
}

function preservesResources(appset: ApplicationSet): boolean {
    return appset.spec?.syncPolicy?.preserveResourcesOnDeletion === true;
}

/** Read one or more ApplicationSet manifests from the file input. */
function readManifests(command: string): Array<Record<string, unknown>> {
    const manifestFile = tl.getPathInput('manifestFile', false, true);
    if (manifestFile === undefined || manifestFile.trim() === '') {
        throw new Error(`The "manifestFile" input is required for the ${command} command.`);
    }
    return parseKubernetesManifests(
        fs.readFileSync(manifestFile, 'utf8'),
        manifestFile,
        APPLICATION_SET_KIND,
    );
}

async function runCreate(client: ArgoCdClient): Promise<void> {
    const manifests = readManifests('create');
    const upsert = tl.getBoolInput('upsert', false);
    const dryRun = tl.getBoolInput('dryRun', false);

    if (dryRun) {
        console.log(
            'Dry run: nothing will be persisted. This reports what each ApplicationSet would own; ' +
                'use the generate command to see the Applications it would produce.',
        );
    }

    const names: string[] = [];
    for (const manifest of manifests) {
        const name = manifestName(manifest);
        console.log(`Creating ApplicationSet "${name}"${upsert ? ' (upsert)' : ''}...`);

        // The body is the bare ApplicationSet; upsert and dryRun travel in the query.
        const created = await client.createApplicationSet(manifest, { upsert, dryRun });
        names.push(name);

        const owned = (created.status?.resources ?? []).length;
        if (owned > 0) {
            console.log(`  ${owned} application(s) ${dryRun ? 'would be' : ''} owned by this ApplicationSet`);
        }
    }

    setOutput('appSetCount', String(names.length));
    setOutput('appSetNames', names.join(','));
    tl.setResult(
        tl.TaskResult.Succeeded,
        `${dryRun ? 'Validated' : 'Created or updated'} ${names.length} ApplicationSet(s): ${names.join(', ')}`,
    );
}

/** Compact view of a generated Application, for the output variable. */
function summariseApplication(app: Application): Record<string, string> {
    return {
        name: app.metadata?.name ?? '',
        namespace: app.spec?.destination?.namespace ?? '',
        project: app.spec?.project ?? '',
        server: app.spec?.destination?.server ?? app.spec?.destination?.name ?? '',
    };
}

async function runGenerate(client: ArgoCdClient): Promise<void> {
    const source = (tl.getInput('generateFrom', false) ?? 'file').toLowerCase();
    const artifactName = (tl.getInput('artifactName', false) ?? 'argocd-generated-apps').trim();

    let manifest: Record<string, unknown>;
    let label: string;

    if (source === 'name') {
        // Preview what the ApplicationSet currently in the cluster would produce, which is
        // usually the more useful question than previewing a file.
        const name = requiredInput('name', 'generate');
        const existing = await client.getApplicationSet(name, { appsetNamespace: appsetNamespace() });
        manifest = existing as unknown as Record<string, unknown>;
        label = name;
    } else {
        const manifests = readManifests('generate');
        if (manifests.length > 1) {
            throw new Error(
                `"${manifests.length}" ApplicationSets found in the manifest file. Generate previews ` +
                    'one at a time; split the file or use generateFrom "name".',
            );
        }
        manifest = manifests[0] as Record<string, unknown>;
        label = manifestName(manifest);
    }

    console.log(`Generating applications for "${label}"...`);
    // Note the wrapped body: this endpoint expects {"applicationSet": ...}.
    const result = await client.generateApplicationSet(manifest);
    const applications = result.applications ?? [];

    for (const app of applications) {
        const summary = summariseApplication(app);
        console.log(`  ${summary.name}  -> ${summary.server}/${summary.namespace}  (project ${summary.project})`);
    }

    if (applications.length === 0) {
        tl.warning(
            'This ApplicationSet generated no applications. Check the generator configuration -- ' +
                'a list generator with no elements, or a cluster generator matching nothing, produces this.',
        );
    }

    // The compact projection goes to a variable; the full objects go to an artifact,
    // because a large ApplicationSet renders hundreds of kilobytes of JSON.
    const compact = applications.map(summariseApplication);
    const filePath = writeOutputFile(`${safeFileName(label)}-generated-apps.json`, JSON.stringify(applications, null, 2));

    echoBounded(JSON.stringify(compact, null, 2), ECHO_LINE_LIMIT, filePath);
    uploadArtifact(filePath, artifactName);

    setOutput('generatedAppCount', String(applications.length));
    setOutput('generatedApps', JSON.stringify(compact));
    setOutput('generatedAppsFile', filePath);
    tl.setResult(tl.TaskResult.Succeeded, `Generated ${applications.length} application(s) from ${label}`);
}

async function runDelete(client: ArgoCdClient): Promise<void> {
    const selector = tl.getInput('selector', false);
    if (selector !== undefined && selector.trim() !== '') {
        throw new Error(
            'The delete command does not accept a label selector. Name each ApplicationSet explicitly ' +
                'in "name" instead -- deleting an ApplicationSet also deletes every Application it ' +
                'generated, so a mistyped selector could remove a great deal at once.',
        );
    }

    const names = tl
        .getDelimitedInput('name', '\n', false)
        .map((value) => value.trim())
        .filter((value) => value !== '');

    if (names.length === 0) {
        throw new Error('Name at least one ApplicationSet to delete in "name".');
    }

    if (!tl.getBoolInput('confirm', false)) {
        throw new Error(
            `Refusing to delete ${names.length} ApplicationSet(s) (${names.join(', ')}) without ` +
                'confirmation. Set the "confirm" input to true to proceed. This is deliberate: ' +
                'deleting an ApplicationSet also deletes every Application it generated, and the ' +
                'cluster resources those applications manage.',
        );
    }

    const namespace = appsetNamespace();
    for (const name of names) {
        // Say what is about to happen before doing it -- the cascade is the surprising part.
        try {
            const existing = await client.getApplicationSet(name, { appsetNamespace: namespace });
            const owned = (existing.status?.resources ?? []).length;
            if (preservesResources(existing)) {
                console.log(
                    `${name}: preserveResourcesOnDeletion is set, so its ${owned} application(s) will remain.`,
                );
            } else {
                console.log(
                    `${name}: will also delete ${owned} generated application(s) and the resources they manage.`,
                );
            }
        } catch (error) {
            // Reading it is a courtesy; failing to read must not block the delete.
            tl.debug(`Could not read ${name} before deleting: ${describeError(error)}`);
        }

        console.log(`Deleting ApplicationSet "${name}"...`);
        await client.deleteApplicationSet(name, { appsetNamespace: namespace });
    }

    console.log(
        'Deletion has been requested. Argo CD removes the generated applications asynchronously.',
    );
    setOutput('deletedCount', String(names.length));
    tl.setResult(tl.TaskResult.Succeeded, `Requested deletion of ${names.length} ApplicationSet(s)`);
}

void run();
