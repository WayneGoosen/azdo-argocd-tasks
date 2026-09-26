// Streaming download.
//
// Two reasons this exists rather than reusing the REST transport or tool-lib:
//
//   * The REST transport buffers the whole response and calls toString('utf8'). Fine for a
//     JSON document, catastrophic for a 250 MB binary -- it would both corrupt the bytes and
//     blow up memory.
//   * tool-lib's downloadTool cannot be told about a custom CA. Downloading from an Argo CD
//     server behind an internal PKI needs the same TLS settings the service connection
//     carries, so that path needs its own downloader.
//
// GitHub downloads still go through tool-lib, which brings proxy support and retries for
// free; this is used for the Argo CD server path and for the small HEAD/GET metadata calls.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import type { TlsOptions } from '@azdo-argocd/argocd-client';

const MAX_REDIRECTS = 5;

export interface DownloadResult {
    bytes: number;
}

function requestOptions(target: URL, tls: TlsOptions, method: string): https.RequestOptions {
    const isHttps = target.protocol === 'https:';
    const options: https.RequestOptions = {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers: { 'User-Agent': 'azdo-argocd-tasks' },
    };
    if (isHttps) {
        if (tls.insecureSkipTlsVerify === true) {
            options.rejectUnauthorized = false;
        }
        if (tls.caCertificate !== undefined && tls.caCertificate.trim() !== '') {
            options.ca = tls.caCertificate;
        }
    }
    return options;
}

/** Follow a redirect chain and return the final response, without consuming the body. */
function open(
    url: string,
    tls: TlsOptions,
    method: string,
    redirectsLeft: number,
): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        let target: URL;
        try {
            target = new URL(url);
        } catch {
            reject(new Error(`Invalid download URL: ${url}`));
            return;
        }

        const transport = target.protocol === 'https:' ? https : http;
        const request = transport.request(requestOptions(target, tls, method), (response) => {
            const status = response.statusCode ?? 0;
            const location = response.headers.location;

            if (status >= 300 && status < 400 && typeof location === 'string') {
                response.resume(); // discard the body before following
                if (redirectsLeft <= 0) {
                    reject(new Error(`Too many redirects downloading ${url}`));
                    return;
                }
                // GitHub redirects release downloads to a CDN host, so resolve relative to
                // the current URL rather than assuming an absolute Location.
                open(new URL(location, target).toString(), tls, method, redirectsLeft - 1).then(
                    resolve,
                    reject,
                );
                return;
            }
            resolve(response);
        });

        request.on('error', reject);
        request.end();
    });
}

/** Issue a HEAD and return the redirect target without downloading anything. */
export async function resolveRedirect(url: string, tls: TlsOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        let target: URL;
        try {
            target = new URL(url);
        } catch {
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }
        const transport = target.protocol === 'https:' ? https : http;
        const request = transport.request(requestOptions(target, tls, 'HEAD'), (response) => {
            response.resume();
            const location = response.headers.location;
            if (typeof location !== 'string' || location === '') {
                reject(
                    new Error(
                        `Expected a redirect from ${url} but got HTTP ${response.statusCode ?? 0}. ` +
                            'Use an explicit version instead of "latest" if this persists.',
                    ),
                );
                return;
            }
            resolve(new URL(location, target).toString());
        });
        request.on('error', reject);
        request.end();
    });
}

/** Fetch a small text resource, such as cli_checksums.txt. */
export async function fetchText(url: string, tls: TlsOptions = {}): Promise<string> {
    const response = await open(url, tls, 'GET', MAX_REDIRECTS);
    const status = response.statusCode ?? 0;
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
        chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (status < 200 || status >= 300) {
        throw new Error(`HTTP ${status} fetching ${url}`);
    }
    return body;
}

/** Stream a URL straight to disk. */
export async function downloadToFile(
    url: string,
    destinationPath: string,
    tls: TlsOptions = {},
): Promise<DownloadResult> {
    const response = await open(url, tls, 'GET', MAX_REDIRECTS);
    const status = response.statusCode ?? 0;

    if (status < 200 || status >= 300) {
        response.resume();
        throw new Error(`HTTP ${status} downloading ${url}`);
    }

    const declared = Number.parseInt(String(response.headers['content-length'] ?? ''), 10);

    await new Promise<void>((resolve, reject) => {
        const file = fs.createWriteStream(destinationPath);
        response.on('error', reject);
        file.on('error', reject);
        file.on('finish', resolve);
        response.pipe(file);
    });

    const bytes = fs.statSync(destinationPath).size;

    // Unlike tool-lib, treat a short read as an error. A truncated CLI binary otherwise fails
    // much later as "exec format error", which tells the user nothing.
    if (!Number.isNaN(declared) && declared > 0 && bytes !== declared) {
        throw new Error(
            `Download of ${url} was truncated: expected ${declared} bytes, got ${bytes}.`,
        );
    }

    return { bytes };
}
