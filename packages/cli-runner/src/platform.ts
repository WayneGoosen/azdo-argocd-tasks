// Mapping the agent's platform to an Argo CD release asset.
//
// The assets are RAW BINARIES, not archives -- goreleaser is configured with
// `formats: [binary]`, and the downloads really are bare ELF / Mach-O / PE files. So there
// is no extraction step anywhere in the installer.

export interface PlatformAsset {
    /** Asset filename in the GitHub release, e.g. "argocd-linux-amd64". */
    assetName: string;
    /** Filename to cache it under, e.g. "argocd" or "argocd.exe". */
    cachedName: string;
    /** Set when the exact platform/arch pair has no asset and a fallback was chosen. */
    fallbackNote?: string;
}

/** Argo CD publishes Go-style arch names; Node reports its own. */
function toGoArch(arch: string): string {
    switch (arch) {
        case 'x64':
            return 'amd64';
        case 'arm64':
            return 'arm64';
        case 'ppc64':
            return 'ppc64le';
        case 's390x':
            return 's390x';
        default:
            return arch;
    }
}

function toGoOs(platform: string): string {
    // Node reports "win32" for every Windows; Argo CD names the asset "windows".
    return platform === 'win32' ? 'windows' : platform;
}

export function platformAsset(platform: string, arch: string): PlatformAsset {
    const goOs = toGoOs(platform);
    let goArch = toGoArch(arch);
    let fallbackNote: string | undefined;

    // goreleaser explicitly ignores windows/arm64, so that asset does not exist. Windows on
    // ARM runs x64 binaries under emulation, so amd64 is the working choice rather than a
    // hard failure.
    if (goOs === 'windows' && goArch === 'arm64') {
        goArch = 'amd64';
        fallbackNote =
            'Argo CD publishes no windows/arm64 CLI build, so the amd64 binary will be used under emulation.';
    }

    const isWindows = goOs === 'windows';
    return {
        assetName: `argocd-${goOs}-${goArch}${isWindows ? '.exe' : ''}`,
        cachedName: isWindows ? 'argocd.exe' : 'argocd',
        ...(fallbackNote === undefined ? {} : { fallbackNote }),
    };
}

export const SUPPORTED_ASSETS: readonly string[] = [
    'argocd-linux-amd64',
    'argocd-linux-arm64',
    'argocd-linux-ppc64le',
    'argocd-linux-s390x',
    'argocd-darwin-amd64',
    'argocd-darwin-arm64',
    'argocd-windows-amd64.exe',
];
