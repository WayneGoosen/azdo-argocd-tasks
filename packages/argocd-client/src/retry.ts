// Retry policy.
//
// The important rule here is asymmetric: reads may always be retried, writes may not.
// POST /sync is not idempotent in the way a retry needs -- it enqueues an Operation. If
// the server already received the request, a retry starts a SECOND sync. So writes only
// retry when we know the request never produced a response byte (TransportError with
// responseStarted === false) or when the server explicitly rejected it before processing
// (429).

import { TransportError } from './transport';

export interface RetryOptions {
    /** Total attempts including the first. 1 disables retrying. */
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    /** Injected for deterministic tests. */
    random: () => number;
    sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY: RetryOptions = {
    maxAttempts: 4,
    baseDelayMs: 500,
    maxDelayMs: 8000,
    random: Math.random,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Statuses worth retrying on a read: transient server or gateway conditions. */
const RETRYABLE_READ_STATUSES = new Set([429, 502, 503, 504]);

/** A write may only be retried when the server certainly has not acted on it. */
const RETRYABLE_WRITE_STATUSES = new Set([429]);

export function isRetryableStatus(status: number, isWrite: boolean): boolean {
    return isWrite ? RETRYABLE_WRITE_STATUSES.has(status) : RETRYABLE_READ_STATUSES.has(status);
}

export function isRetryableTransportError(error: TransportError, isWrite: boolean): boolean {
    return isWrite ? !error.responseStarted : true;
}

/**
 * Full-jitter exponential backoff: delay = random() * min(maxDelay, base * 2^attempt).
 *
 * Full jitter rather than equal jitter because pipeline agents in a fan-out deployment
 * all poll the same Argo CD instance, and the goal is to spread them, not to preserve a
 * minimum wait.
 */
export function computeBackoffMs(attempt: number, options: RetryOptions): number {
    const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
    return Math.floor(options.random() * ceiling);
}
