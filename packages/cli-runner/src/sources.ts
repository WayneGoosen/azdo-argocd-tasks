import { trimSlashes } from '@azdo-argocd/argocd-client';
// Where to fetch the argocd CLI from.
//
// Two sources, and they are NOT interchangeable.
//
// GitHub releases publish every platform and ship cli_checksums.txt.
//
// The Argo CD server publishes exactly one binary: its own. `registerDownloadHandlers` in
// server/server.go looks up `argocd` on the server's $PATH and re-serves that single file,
// registering only `/download/argocd-linux-<server GOARCH>` (plus an arch-less
// `/download/argocd-linux` from 3.5 onward). There is no darwin or windows route, and no
// route for any arch but the server's own.
//
// So the widely-repeated `{server}/download/argocd-{platform}-{arch}` pattern is wrong, and
// asking a server for a darwin binary is a guaranteed 404. The upside of the server source
// is a guaranteed version match with the server you are talking to, and no GitHub egress --
// which matters for air-gapped agents.

export const GITHUB_REPO = 'https://github.com/argoproj/argo-cd';
export const GITHUB_LATEST_RELEASE_URL = `${GITHUB_REPO}/releases/latest`;
export const CHECKSUMS_ASSET = 'cli_checksums.txt';

/**
 * Base URL for release assets.
 *
 * Overridable so an air-gapped or bandwidth-constrained organisation can mirror the release
 * assets internally -- these binaries are ~250 MB each and Microsoft-hosted agents re-download
 * them every run. A mirror must lay assets out the same way GitHub does:
 * `<base>/releases/download/<tag>/<asset>`.
 */
export function releaseBaseUrl(override?: string  ): string {
    const trimmed = (override ?? '').trim();
    return trimmed === '' ? GITHUB_REPO : trimSlashes(trimmed);
}

export function githubAssetUrl(tag: string, assetName: string, baseUrl?: string  ): string {
    return `${releaseBaseUrl(baseUrl)}/releases/download/${tag}/${assetName}`;
}

export function githubChecksumsUrl(tag: string, baseUrl?: string  ): string {
    return githubAssetUrl(tag, CHECKSUMS_ASSET, baseUrl);
}

/**
 * The server's download route. Linux only, and only for the server's own architecture.
 * Built by joining onto the connection URL's path so `--rootpath` installs work.
 */
export function serverDownloadUrl(serverUrl: string, goArch: string): string {
    const base = trimSlashes(serverUrl.trim());
    return `${base}/download/argocd-linux-${goArch}`;
}

export interface ServerDownloadEligibility {
    eligible: boolean;
    /** Why, phrased for a pipeline log. */
    reason: string;
}

/**
 * Decide whether the Argo CD server can serve this agent a usable binary.
 *
 * `serverPlatform` is the `Platform` field from GET /api/version, e.g. "linux/amd64".
 * When it is unknown we only require the agent to be Linux and accept the risk of a 404,
 * which is still better than the prior-art behaviour of always trying.
 */
export function canUseServerDownload(args: {
    agentPlatform: string;
    agentGoArch: string;
    serverPlatform?: string | undefined;
}): ServerDownloadEligibility {
    if (args.agentPlatform !== 'linux') {
        return {
            eligible: false,
            reason:
                `the Argo CD server only serves a Linux CLI binary and this agent is ${args.agentPlatform}`,
        };
    }

    if (args.serverPlatform === undefined || args.serverPlatform === '') {
        return { eligible: true, reason: 'the server did not report its platform; attempting anyway' };
    }

    const serverArch = args.serverPlatform.split('/')[1];
    if (serverArch !== undefined && serverArch !== args.agentGoArch) {
        return {
            eligible: false,
            reason:
                `the server runs ${args.serverPlatform} and this agent is linux/${args.agentGoArch}, ` +
                'and the server only publishes its own architecture',
        };
    }

    return { eligible: true, reason: `the server runs ${args.serverPlatform}, matching this agent` };
}
