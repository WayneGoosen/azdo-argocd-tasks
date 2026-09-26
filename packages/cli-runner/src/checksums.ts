// SHA-256 verification of downloaded CLI binaries.
//
// This is not belt-and-braces. tool-lib's downloadTool logs a Content-Length mismatch as a
// WARNING and returns successfully, so a truncated 250 MB download otherwise sails through
// and fails later as an inscrutable "exec format error". The prior-art installer extension
// does no verification at all; this is the clearest thing to improve on.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

// One line of GNU sha256sum output: digest, whitespace, optional binary-mode `*`, filename.
// Case-insensitive on the digest: sha256sum emits lowercase, but other tools emit uppercase,
// and silently skipping such a line would mean "no checksum published" rather than a match.
const CHECKSUM_LINE = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/;

/**
 * Parse an Argo CD `cli_checksums.txt`.
 * Unparseable lines are skipped rather than fatal -- upstream may add a header or a
 * signature block, and that should not break an otherwise valid verification.
 */
export function parseChecksums(text: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const line of text.split('\n')) {
        const match = CHECKSUM_LINE.exec(line.trim());
        if (match !== null) {
            result.set(match[2] as string, (match[1] as string).toLowerCase());
        }
    }
    return result;
}

/** Hash a file without reading it into memory -- these binaries are ~250 MB. */
export function sha256OfFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

export class ChecksumMismatchError extends Error {
    public constructor(assetName: string, expected: string, actual: string) {
        super(
            `Checksum mismatch for ${assetName}.\n` +
                `  expected: ${expected}\n` +
                `  actual:   ${actual}\n` +
                'The download was corrupted or truncated, or the release assets have changed. ' +
                'Re-run the pipeline; if it persists, report it.',
        );
        this.name = 'ChecksumMismatchError';
    }
}

export async function verifyChecksum(
    filePath: string,
    assetName: string,
    checksums: Map<string, string>,
): Promise<void> {
    const expected = checksums.get(assetName);
    if (expected === undefined) {
        throw new Error(
            `No checksum published for "${assetName}". Set verifyChecksum to false to skip ` +
                'verification, but prefer reporting this -- it usually means the asset name changed.',
        );
    }
    const actual = await sha256OfFile(filePath);
    if (actual !== expected) {
        throw new ChecksumMismatchError(assetName, expected, actual);
    }
}
