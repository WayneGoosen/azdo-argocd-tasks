import { describe, expect, it } from 'vitest';
import { SUPPORTED_ASSETS, platformAsset } from '../src/platform';

describe('platformAsset', () => {
    it.each([
        ['linux', 'x64', 'argocd-linux-amd64', 'argocd'],
        ['linux', 'arm64', 'argocd-linux-arm64', 'argocd'],
        ['darwin', 'x64', 'argocd-darwin-amd64', 'argocd'],
        ['darwin', 'arm64', 'argocd-darwin-arm64', 'argocd'],
        ['win32', 'x64', 'argocd-windows-amd64.exe', 'argocd.exe'],
    ])('maps %s/%s to %s', (platform, arch, assetName, cachedName) => {
        const asset = platformAsset(platform, arch);
        expect(asset.assetName).toBe(assetName);
        expect(asset.cachedName).toBe(cachedName);
        expect(asset.fallbackNote).toBeUndefined();
    });

    it('falls back to amd64 on Windows ARM, because no such asset is published', () => {
        const asset = platformAsset('win32', 'arm64');
        expect(asset.assetName).toBe('argocd-windows-amd64.exe');
        expect(asset.fallbackNote).toMatch(/no windows\/arm64/i);
    });

    it('produces only asset names Argo CD actually publishes', () => {
        for (const [platform, arch] of [
            ['linux', 'x64'],
            ['linux', 'arm64'],
            ['darwin', 'x64'],
            ['darwin', 'arm64'],
            ['win32', 'x64'],
            ['win32', 'arm64'],
        ] as Array<[string, string]>) {
            expect(SUPPORTED_ASSETS).toContain(platformAsset(platform, arch).assetName);
        }
    });
});
