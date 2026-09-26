// HTTP transport for the Argo CD REST API.
//
// Why node:https rather than global fetch: the service connection can carry a custom
// CA (internal PKI) or ask to skip TLS verification. With fetch that means supplying an
// undici Agent as a `dispatcher`, which turns undici into a real runtime dependency for
// something node:https does natively. Keeping this on node:https means the shipped
// bundle has zero runtime dependencies.
//
// The transport is an interface, not a concrete call, so every unit test injects a fake
// and no test ever opens a socket.

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequest {
    method: HttpMethod;
    url: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs: number;
}

export interface HttpResponse {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export interface TlsOptions {
    /** PEM-encoded CA bundle for an internal certificate authority. */
    caCertificate?: string;
    /** Disable certificate verification. Logged loudly by the task when enabled. */
    insecureSkipTlsVerify?: boolean;
}

/**
 * A transport-level failure: DNS, TCP, TLS or timeout. Distinct from an HTTP error
 * response, which is a perfectly good HttpResponse with a 4xx/5xx status.
 *
 * `responseStarted` is what makes the write-retry rule safe: if no response byte was
 * ever received, the server cannot have acted on the request, so retrying a POST is
 * sound. Once a response has begun, a retry would be a second operation.
 */
export class TransportError extends Error {
    public readonly code: string | undefined;
    public readonly responseStarted: boolean;

    public constructor(message: string, code: string | undefined, responseStarted: boolean) {
        super(message);
        this.name = 'TransportError';
        this.code = code;
        this.responseStarted = responseStarted;
    }
}

export function createNodeHttpsTransport(tls: TlsOptions = {}): Transport {
    return function nodeHttpsTransport(req: HttpRequest): Promise<HttpResponse> {
        return new Promise<HttpResponse>((resolve, reject) => {
            let parsed: URL;
            try {
                parsed = new URL(req.url);
            } catch {
                reject(new TransportError(`Invalid URL: ${req.url}`, 'ERR_INVALID_URL', false));
                return;
            }

            const isHttps = parsed.protocol === 'https:';
            const transportModule = isHttps ? https : http;
            let responseStarted = false;
            let settled = false;

            const options: https.RequestOptions = {
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: `${parsed.pathname}${parsed.search}`,
                method: req.method,
                headers: req.headers,
            };

            if (isHttps) {
                if (tls.insecureSkipTlsVerify === true) {
                    options.rejectUnauthorized = false;
                }
                if (tls.caCertificate !== undefined && tls.caCertificate.trim() !== '') {
                    options.ca = tls.caCertificate;
                }
            }

            const fail = (err: NodeJS.ErrnoException): void => {
                if (settled) {
                    return;
                }
                settled = true;
                reject(new TransportError(err.message, err.code, responseStarted));
            };

            const clientRequest = transportModule.request(options, (res) => {
                responseStarted = true;
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('error', fail);
                res.on('end', () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                    });
                });
            });

            clientRequest.on('error', fail);

            // setTimeout only fires on socket inactivity, so destroy explicitly to make
            // the deadline real. A refreshing Get can legitimately block for minutes, so
            // callers pass a much larger timeoutMs for those.
            clientRequest.setTimeout(req.timeoutMs, () => {
                clientRequest.destroy(
                    Object.assign(new Error(`Request timed out after ${req.timeoutMs}ms`), {
                        code: 'ETIMEDOUT',
                    }),
                );
            });

            if (req.body !== undefined) {
                clientRequest.write(req.body);
            }
            clientRequest.end();
        });
    };
}
