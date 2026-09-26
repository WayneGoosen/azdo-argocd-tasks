// Parsing the Argo CD pod-log stream.
//
// The logs endpoint is a grpc-gateway STREAMING response: newline-delimited JSON, one
// object per line, each wrapped in an envelope:
//
//     {"result":{"content":"...","timeStampStr":"...","last":false,"podName":"..."}}
//
// Three things make this different from every other endpoint in this client:
//
//   1. THE ENVELOPE. The payload is under `result`, not at the top level.
//   2. ERRORS ARRIVE WITH HTTP 200. grpc-gateway has already flushed response headers by
//      the time the server discovers a problem, so an RBAC denial or "max pods to view
//      logs reached" shows up as an {"error":{...}} LINE mid-stream. A client that only
//      checks the status code reports success and silently returns partial logs.
//   3. THE END IS MARKED, NOT IMPLIED. With follow disabled the server sends a final
//      entry with `last: true`. A stream that stops without it was truncated.
//
// Kept pure and separate from the client so all of that is testable without a socket.

import { ArgoCdApiError } from './errors';
import { LogEntry } from './types';

interface LogEnvelope {
    result?: LogEntry;
    error?: {
        grpc_code?: number;
        http_code?: number;
        message?: string;
        http_status?: string;
    };
}

export interface LogStreamResult {
    entries: LogEntry[];
    /** False when the terminating `last: true` entry never arrived. */
    complete: boolean;
    /** Lines that were not valid JSON, usually a stream cut mid-line. */
    malformedLines: number;
}

/**
 * Parse a complete NDJSON log stream body.
 *
 * Throws if the stream carried an error object, because that is a real failure the caller
 * must not mistake for "no logs".
 */
export function parseLogStream(body: string, context: { path: string }): LogStreamResult {
    const entries: LogEntry[] = [];
    let complete = false;
    let malformedLines = 0;

    for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        if (line === '') {
            continue;
        }

        let envelope: LogEnvelope;
        try {
            envelope = JSON.parse(line) as LogEnvelope;
        } catch {
            malformedLines += 1;
            continue;
        }

        if (envelope.error !== undefined) {
            const status = envelope.error.http_code ?? 0;
            throw new ArgoCdApiError({
                message: envelope.error.message ?? 'The Argo CD log stream reported an error',
                httpStatus: status,
                grpcCode: envelope.error.grpc_code,
                method: 'GET',
                path: context.path,
                hint:
                    status === 403
                        ? 'Reading pod logs needs the separate "logs" RBAC resource, not ' +
                          '"applications". Grant it explicitly, for example: ' +
                          'p, role:ci, logs, get, <project>/*, allow'
                        : undefined,
            });
        }

        if (envelope.result === undefined) {
            continue;
        }

        if (envelope.result.last === true) {
            complete = true;
            // The terminator can also carry content, so keep it when it does.
            if ((envelope.result.content ?? '') === '') {
                continue;
            }
        }
        entries.push(envelope.result);
    }

    return { entries, complete, malformedLines };
}

/** Render entries as plain text, prefixing the pod name when several pods are interleaved. */
export function formatLogEntries(entries: readonly LogEntry[]): string {
    const pods = new Set(entries.map((entry) => entry.podName ?? ''));
    const multiplePods = pods.size > 1;

    return entries
        .map((entry) => {
            const content = entry.content ?? '';
            return multiplePods && entry.podName !== undefined && entry.podName !== ''
                ? `[${entry.podName}] ${content}`
                : content;
        })
        .join('\n');
}
