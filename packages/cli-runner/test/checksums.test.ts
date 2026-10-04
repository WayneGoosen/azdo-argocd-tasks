import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChecksumMismatchError, parseChecksums, sha256OfFile, verifyChecksum } from '../src/checksums';

// The exact shape of a real Argo CD cli_checksums.txt: digest, two spaces, bare filename.
const REAL_CHECKSUMS = `44c636381ad52a92caa493e4a292dc04f3bf3da7f5ab7b9fe055aeaf661f9cdd  argocd-darwin-amd64
76efc71c00bc3ffeda5daa277d990e3d89b3628b2440fc7dd38aca79c63b15e0  argocd-darwin-arm64
b860f73f57cbddd993cd446f5236d797c1b1ac8554857b2683d2669f17e765b4  argocd-linux-amd64
c7c5a152fe865f2262f4bb19eda66baf590cc18e0e125a902ba6942cbeee92e9  argocd-windows-amd64.exe
`;

describe('parseChecksums', () => {
    it('parses the real Argo CD format', () => {
        const checksums = parseChecksums(REAL_CHECKSUMS);
        expect(checksums.size).toBe(4);
        expect(checksums.get('argocd-linux-amd64')).toBe(
            'b860f73f57cbddd993cd446f5236d797c1b1ac8554857b2683d2669f17e765b4',
        );
        expect(checksums.get('argocd-windows-amd64.exe')).toBeDefined();
    });

    it('accepts the binary-mode asterisk marker', () => {
        const checksums = parseChecksums(`${'a'.repeat(64)} *argocd-linux-amd64`);
        expect(checksums.get('argocd-linux-amd64')).toBe('a'.repeat(64));
    });

    it('skips unparseable lines rather than failing', () => {
        // Upstream could add a header or signature block; that must not break verification.
        const checksums = parseChecksums(`# a header\n\n${'b'.repeat(64)}  argocd-linux-amd64\ngarbage`);
        expect(checksums.size).toBe(1);
    });

    it('lowercases digests so comparison is case-insensitive', () => {
        expect(parseChecksums(`${'A'.repeat(64)}  x`).get('x')).toBe('a'.repeat(64));
    });

    it('returns an empty map for empty input', () => {
        expect(parseChecksums('').size).toBe(0);
    });
});

describe('sha256OfFile and verifyChecksum', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argocd-checksum-'));
    const file = path.join(dir, 'argocd-linux-amd64');
    fs.writeFileSync(file, 'hello argocd');
    // Computed independently of the implementation.
    const digest = crypto.createHash('sha256').update('hello argocd').digest('hex');

    it('hashes a file', async () => {
        await expect(sha256OfFile(file)).resolves.toBe(digest);
    });

    it('passes when the digest matches', async () => {
        await expect(
            verifyChecksum(file, 'argocd-linux-amd64', new Map([['argocd-linux-amd64', digest]])),
        ).resolves.toBeUndefined();
    });

    it('rejects a corrupted or truncated download', async () => {
        // This is the case tool-lib's downloadTool only warns about.
        await expect(
            verifyChecksum(file, 'argocd-linux-amd64', new Map([['argocd-linux-amd64', 'f'.repeat(64)]])),
        ).rejects.toBeInstanceOf(ChecksumMismatchError);
    });

    it('fails clearly when no checksum is published for the asset', async () => {
        await expect(verifyChecksum(file, 'argocd-linux-amd64', new Map())).rejects.toThrow(
            /No checksum published/,
        );
    });
});
