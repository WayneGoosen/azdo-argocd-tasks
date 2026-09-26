// Version resolution for the argocd CLI.
//
// Three shapes go in -- "server", "latest", or an explicit version -- and a GitHub release
// tag comes out.
//
// The build-metadata strip is the part that matters. An Argo CD server reports its version
// as `v3.6.0+b5fc12e`; the release tag is `v3.6.0`. Everything after `+` is build metadata
// and must go, while a prerelease suffix (`-rc1`) must be KEPT, because it is part of the
// tag.
//
// This does the job semver.clean() would, but without importing azure-pipelines-tool-lib:
// that package pulls in azure-pipelines-task-lib, whose module-level initialisation reads
// pipeline environment variables and emits agent debug output the moment it loads. Keeping
// this module pure means its tests need no agent at all.

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/**
 * Normalise any accepted version spelling to a `vX.Y.Z` release tag.
 * Throws with an actionable message rather than producing a tag that 404s later.
 */
export function normaliseVersionTag(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed === '') {
        throw new Error('No Argo CD CLI version was given.');
    }

    // Drop build metadata first: `v3.6.0+b5fc12e` -> `v3.6.0`.
    const withoutBuild = trimmed.split('+')[0] as string;
    const withoutPrefix = withoutBuild.replace(/^v/i, '');

    if (!VERSION_PATTERN.test(withoutPrefix)) {
        throw new Error(
            `"${raw}" is not a valid Argo CD version. Use "server", "latest", or an explicit ` +
                'version such as "v3.5.3".',
        );
    }
    return `v${withoutPrefix}`;
}

/**
 * The form the Azure Pipelines tool cache wants: no leading `v`.
 * tool-lib runs semver.clean() on this internally, and a non-semver string silently becomes
 * null, which yields a broken cache path rather than an error.
 */
export function versionForCache(tag: string): string {
    return tag.replace(/^v/i, '');
}

/** Extract the tag from the `Location` of a redirect on `/releases/latest`. */
export function tagFromReleaseRedirect(location: string): string {
    const segments = location.split('?')[0]?.split('/').filter((part) => part !== '') ?? [];
    const last = segments[segments.length - 1];
    if (last === undefined || last === '') {
        throw new Error(`Could not read a release tag from the redirect "${location}".`);
    }
    return normaliseVersionTag(last);
}
