// ArgoCDInstall@1 -- download, verify and cache the argocd CLI.
//
// Worth knowing before reaching for this task: the Azure Pipelines tool cache lives in
// Agent.ToolsDirectory, which only persists on SELF-HOSTED agents. On Microsoft-hosted
// agents the cache starts cold every run, so this downloads ~250 MB each time. That cost is
// exactly what ArgoCDApp@1 avoids by speaking REST, so install the CLI only when you need
// something the API cannot do -- `app diff --local`, `--core` mode, `admin` subcommands.
//
// Two download sources, and they are not interchangeable:
//
//   GitHub  -- every platform, and cli_checksums.txt to verify against. Goes through
//              tool-lib's downloader, which honours the agent's proxy configuration.
//   Server  -- the Argo CD server re-serves its own binary from $PATH. LINUX ONLY, and only
//              for the server's own architecture, because that is the only route
//              registerDownloadHandlers registers. Guarantees a version match with the
//              server and needs no GitHub egress, which matters for air-gapped agents. Uses
//              our own downloader so the connection's custom CA is honoured -- tool-lib's
//              cannot be told about one.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tl from 'azure-pipelines-task-lib/task';
import * as toolLib from 'azure-pipelines-tool-lib/tool';
import { ArgoCdClient, createNodeHttpsTransport } from '@azdo-argocd/argocd-client';
import {
    describeError,
    getBoolInputOrDefault,
    readArgoCdEndpoint,
    setOutput,
} from '@azdo-argocd/task-common';
import {
    GITHUB_LATEST_RELEASE_URL,
    canUseServerDownload,
    downloadToFile,
    fetchText,
    githubAssetUrl,
    githubChecksumsUrl,
    normaliseVersionTag,
    parseChecksums,
    platformAsset,
    resolveRedirect,
    serverDownloadUrl,
    tagFromReleaseRedirect,
    verifyChecksum,
    versionForCache,
} from '@azdo-argocd/cli-runner';

const TOOL_NAME = 'argocd';

interface ResolvedEndpoint {
    url: string;
    token: string | undefined;
    caCertificate: string | undefined;
    insecureSkipTlsVerify: boolean;
}

async function run(): Promise<void> {
    try {
        const versionSpec = (tl.getInput('version', false) ?? 'server').trim();
        const source = (tl.getInput('source', false) ?? 'auto').toLowerCase();
        const shouldVerify = getBoolInputOrDefault('verifyChecksum', true);

        // The connection is only needed to ask the server its version or to download from it.
        const needsConnection = versionSpec.toLowerCase() === 'server' || source === 'server';
        const endpoint = readEndpoint(needsConnection);

        const asset = platformAsset(process.platform, process.arch);
        if (asset.fallbackNote !== undefined) {
            tl.warning(asset.fallbackNote);
        }

        const { tag, serverPlatform } = await resolveVersion(versionSpec, endpoint);
        console.log(`Resolved Argo CD CLI version ${tag} (${asset.assetName}).`);

        const cached = findCached(tag);
        if (cached !== undefined) {
            console.log(`Found ${TOOL_NAME} ${tag} in the tool cache.`);
            finish(cached, asset.cachedName, tag);
            return;
        }

        const binaryPath = await download({
            tag,
            assetName: asset.assetName,
            cachedName: asset.cachedName,
            source,
            endpoint,
            serverPlatform,
            shouldVerify,
        });

        const toolFolder = await cache(binaryPath, asset.cachedName, tag);
        finish(toolFolder, asset.cachedName, tag);
    } catch (error) {
        tl.setResult(tl.TaskResult.Failed, describeError(error));
    }
}

function readEndpoint(required: boolean): ResolvedEndpoint | undefined {
    const connectionId = tl.getInput('connection', false);
    if (connectionId === undefined || connectionId === '') {
        if (required) {
            throw new Error(
                'An Argo CD service connection is required when version is "server" or source is ' +
                    '"server". Either supply one, or set version to "latest" or an explicit version.',
            );
        }
        return undefined;
    }
    const endpoint = readArgoCdEndpoint('connection');
    return {
        url: endpoint.url,
        token: endpoint.token,
        caCertificate: endpoint.caCertificate,
        insecureSkipTlsVerify: endpoint.insecureSkipTlsVerify,
    };
}

async function resolveVersion(
    versionSpec: string,
    endpoint: ResolvedEndpoint | undefined,
): Promise<{ tag: string; serverPlatform: string | undefined }> {
    const spec = versionSpec.toLowerCase();

    if (spec === 'server') {
        if (endpoint === undefined) {
            throw new Error('version "server" requires an Argo CD service connection.');
        }
        const client = new ArgoCdClient({
            serverUrl: endpoint.url,
            token: endpoint.token,
            transport: createNodeHttpsTransport({
                caCertificate: endpoint.caCertificate,
                insecureSkipTlsVerify: endpoint.insecureSkipTlsVerify,
            }),
        });
        const version = await client.getVersion();
        if (version.Version === undefined || version.Version === '') {
            throw new Error('The Argo CD server did not report a version.');
        }
        // Servers report `v3.6.0+b5fc12e`; the release tag is `v3.6.0`.
        return { tag: normaliseVersionTag(version.Version), serverPlatform: version.Platform };
    }

    if (spec === 'latest') {
        // A HEAD on /releases/latest avoids the GitHub API entirely: no rate limit, no token.
        const location = await resolveRedirect(GITHUB_LATEST_RELEASE_URL);
        return { tag: tagFromReleaseRedirect(location), serverPlatform: undefined };
    }

    return { tag: normaliseVersionTag(versionSpec), serverPlatform: undefined };
}

/** Tool-cache lookup that tolerates an agent without Agent.ToolsDirectory. */
function findCached(tag: string): string | undefined {
    try {
        const found = toolLib.findLocalTool(TOOL_NAME, versionForCache(tag));
        return found === undefined || found === '' ? undefined : found;
    } catch (error) {
        tl.debug(`Tool cache unavailable: ${describeError(error)}`);
        return undefined;
    }
}

async function download(args: {
    tag: string;
    assetName: string;
    cachedName: string;
    source: string;
    endpoint: ResolvedEndpoint | undefined;
    serverPlatform: string | undefined;
    shouldVerify: boolean;
}): Promise<string> {
    const goArch = args.assetName.split('-')[2]?.replace('.exe', '') ?? 'amd64';
    const eligibility = canUseServerDownload({
        agentPlatform: process.platform,
        agentGoArch: goArch,
        serverPlatform: args.serverPlatform,
    });

    const useServer =
        args.endpoint !== undefined &&
        (args.source === 'server' || (args.source === 'auto' && eligibility.eligible));

    if (args.source === 'server' && args.endpoint === undefined) {
        throw new Error('source "server" requires an Argo CD service connection.');
    }
    if (args.source === 'server' && !eligibility.eligible) {
        throw new Error(
            `Cannot download from the Argo CD server because ${eligibility.reason}. ` +
                'Use source "github" or "auto" instead.',
        );
    }

    if (useServer) {
        const endpoint = args.endpoint as ResolvedEndpoint;
        const url = serverDownloadUrl(endpoint.url, goArch);
        console.log(`Downloading from the Argo CD server (${eligibility.reason}).`);
        console.log(`  ${url}`);
        const destination = path.join(tempDirectory(), args.cachedName);
        const { bytes } = await downloadToFile(url, destination, {
            caCertificate: endpoint.caCertificate,
            insecureSkipTlsVerify: endpoint.insecureSkipTlsVerify,
        });
        console.log(`  downloaded ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
        // No checksum here: the server serves its own build, which for a vendor or
        // development build legitimately differs from the published release.
        console.log('  skipping checksum verification (the server serves its own build)');
        return destination;
    }

    if (args.source === 'auto' && !eligibility.eligible) {
        console.log(`Using GitHub releases because ${eligibility.reason}.`);
    }

    // An internal mirror keeps ~250 MB per run off the public internet, and is the only
    // workable GitHub path for an air-gapped agent.
    const mirror = tl.getVariable('ARGOCD_CLI_MIRROR');
    if (mirror !== undefined && mirror.trim() !== '') {
        console.log(`Using release mirror ${mirror}`);
    }
    const url = githubAssetUrl(args.tag, args.assetName, mirror);
    console.log(`Downloading ${url}`);

    let downloaded: string;
    try {
        // tool-lib's downloader, rather than ours, so the agent's proxy configuration applies.
        downloaded = await toolLib.downloadToolWithRetries(url, args.cachedName);
    } catch (error) {
        throw new Error(describeDownloadFailure(error, args.tag), { cause: error });
    }

    if (args.shouldVerify) {
        const checksumsUrl = githubChecksumsUrl(args.tag, mirror);
        console.log(`Verifying SHA-256 against ${checksumsUrl}`);
        const checksums = parseChecksums(await fetchText(checksumsUrl));
        await verifyChecksum(downloaded, args.assetName, checksums);
        console.log('  checksum OK');
    } else {
        tl.warning('Checksum verification is disabled for this download.');
    }

    return downloaded;
}

/**
 * A 404 here almost always means the server reported a version with no public release --
 * a release candidate, a development build, or a vendor distribution.
 */
function describeDownloadFailure(error: unknown, tag: string): string {
    const message = describeError(error);
    if (/404|not found/i.test(message)) {
        return (
            `No Argo CD release found for ${tag}. This happens when the Argo CD server runs a ` +
            'release candidate, a development build or a vendor distribution whose version has no ' +
            'matching GitHub release. Pin an explicit version instead, for example version: v3.5.3.\n' +
            `Original error: ${message}`
        );
    }
    return message;
}

function tempDirectory(): string {
    const directory = path.join(tl.getVariable('Agent.TempDirectory') ?? os.tmpdir(), 'argocd-install');
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

/** Cache the binary, falling back to a temp directory when there is no tool cache. */
async function cache(binaryPath: string, cachedName: string, tag: string): Promise<string> {
    // tool-lib does no chmod of its own, so an un-executable binary would otherwise be
    // cached and fail later with a permission error.
    if (process.platform !== 'win32') {
        fs.chmodSync(binaryPath, 0o755);
    }

    try {
        // Note cacheFile returns the FOLDER, not the file path.
        return await toolLib.cacheFile(binaryPath, cachedName, TOOL_NAME, versionForCache(tag));
    } catch (error) {
        tl.warning(
            `Could not use the tool cache (${describeError(error)}). The CLI will be used from a ` +
                'temporary directory instead and re-downloaded on the next run.',
        );
        const staging = path.join(tempDirectory(), versionForCache(tag));
        fs.mkdirSync(staging, { recursive: true });
        const staged = path.join(staging, cachedName);
        fs.copyFileSync(binaryPath, staged);
        if (process.platform !== 'win32') {
            fs.chmodSync(staged, 0o755);
        }
        return staging;
    }
}

function finish(toolFolder: string, cachedName: string, tag: string): void {
    toolLib.prependPath(toolFolder);

    const binaryPath = path.join(toolFolder, cachedName);
    setOutput('argocdPath', binaryPath);
    setOutput('argocdVersion', tag);

    // Prove it actually runs rather than trusting that a file of the right name exists.
    const result = tl.execSync(binaryPath, ['version', '--client'], { silent: true });
    if (result.code !== 0) {
        throw new Error(
            `The downloaded argocd binary could not be executed (exit code ${result.code}).\n` +
                `${result.stderr || result.stdout}`,
        );
    }
    console.log((result.stdout || '').trim());
    tl.setResult(tl.TaskResult.Succeeded, `Argo CD CLI ${tag} is on PATH at ${binaryPath}`);
}

void run();
