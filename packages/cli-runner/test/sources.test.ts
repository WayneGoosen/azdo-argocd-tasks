import { describe, expect, it } from 'vitest';
import { canUseServerDownload, githubAssetUrl, githubChecksumsUrl, serverDownloadUrl } from '../src/sources';

describe('GitHub URLs', () => {
    it('builds an asset URL', () => {
        expect(githubAssetUrl('v3.5.3', 'argocd-linux-amd64')).toBe(
            'https://github.com/argoproj/argo-cd/releases/download/v3.5.3/argocd-linux-amd64',
        );
    });

    it('builds the checksums URL', () => {
        expect(githubChecksumsUrl('v3.5.3')).toBe(
            'https://github.com/argoproj/argo-cd/releases/download/v3.5.3/cli_checksums.txt',
        );
    });
});

describe('serverDownloadUrl', () => {
    it('targets the Linux route', () => {
        expect(serverDownloadUrl('https://argocd.example.com', 'amd64')).toBe(
            'https://argocd.example.com/download/argocd-linux-amd64',
        );
    });

    it('preserves a sub-path install', () => {
        expect(serverDownloadUrl('https://example.com/argocd/', 'arm64')).toBe(
            'https://example.com/argocd/download/argocd-linux-arm64',
        );
    });
});

describe('canUseServerDownload', () => {
    it('allows a matching Linux agent', () => {
        const result = canUseServerDownload({
            agentPlatform: 'linux',
            agentGoArch: 'amd64',
            serverPlatform: 'linux/amd64',
        });
        expect(result.eligible).toBe(true);
    });

    it.each(['darwin', 'win32'])('refuses on %s, since the server only serves Linux', (platform) => {
        const result = canUseServerDownload({
            agentPlatform: platform,
            agentGoArch: 'amd64',
            serverPlatform: 'linux/amd64',
        });
        expect(result.eligible).toBe(false);
        expect(result.reason).toMatch(/only serves a Linux CLI binary/);
    });

    it('refuses when the architectures differ', () => {
        // The server registers only its own GOARCH route, so this would be a 404.
        const result = canUseServerDownload({
            agentPlatform: 'linux',
            agentGoArch: 'arm64',
            serverPlatform: 'linux/amd64',
        });
        expect(result.eligible).toBe(false);
        expect(result.reason).toMatch(/own architecture/);
    });

    it('attempts anyway when the server did not report a platform', () => {
        const result = canUseServerDownload({ agentPlatform: 'linux', agentGoArch: 'amd64' });
        expect(result.eligible).toBe(true);
        expect(result.reason).toMatch(/did not report/);
    });
});
