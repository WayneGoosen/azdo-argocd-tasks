// A registry of values that must never be written to a file we publish.
//
// WHY THIS EXISTS: `tl.setSecret` masks the AGENT'S LOG STREAM. It does nothing for a file
// this process writes itself. The run summary is exactly that -- `fs.writeFileSync` followed
// by an upload -- so a minted token rendered into Markdown would be published to the build,
// unmasked, on a durable and link-shareable tab.
//
// `docs/security.md` promises tokens are "never written to the run summary". Before run
// summaries existed on the token-minting tasks that promise was true by construction. It is
// now a claim that needs enforcing, so every masked value is also recorded here and
// `publishRunSummary` refuses to publish anything containing one.

import * as tl from 'azure-pipelines-task-lib/task';

/**
 * Structural match for a JWT, which is what Argo CD mints.
 *
 * The registry only knows about secrets this process created. The regex is the backstop for
 * one that arrived some other way -- read back off an object, pasted into an input, returned
 * by a future endpoint nobody has audited yet.
 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/;

const registered: string[] = [];

/**
 * Mask a secret with the agent AND record it, so published files can be checked against it.
 *
 * Use this everywhere instead of calling `tl.setSecret` directly.
 */
export function registerSecret(value: string | undefined): void {
    if (value === undefined || value === '') {
        return;
    }
    tl.setSecret(value);
    if (!registered.includes(value)) {
        registered.push(value);
    }
}

/**
 * The reason `content` must not be published, or undefined when it is safe.
 *
 * Deliberately returns a reason rather than a redacted copy: a hit means a bug upstream put a
 * secret somewhere it should never have reached, and silently scrubbing it would hide that.
 */
export function secretLeakIn(content: string): string | undefined {
    for (const secret of registered) {
        // Check the RAW secret and its JSON-encoded form. The run attachment is checked
        // after JSON.stringify, which escapes quotes, backslashes and control characters --
        // so a secret containing any of them would not match raw and would be published.
        // JSON.stringify wraps in quotes; slice them off to get the escaped body.
        const encoded = JSON.stringify(secret).slice(1, -1);
        if (content.includes(secret) || content.includes(encoded)) {
            return 'it contains a value that was registered as a secret';
        }
    }
    return JWT_PATTERN.test(content) ? 'it contains something shaped like a JWT' : undefined;
}

/** Test seam. Not for task code -- the registry is process-lifetime state by design. */
export function resetRegisteredSecretsForTesting(): void {
    registered.length = 0;
}
