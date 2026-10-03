// The payload the tasks attach to the build and the "Argo CD" tab reads back.
//
// This is a WIRE CONTRACT between two things that are versioned separately: the task that
// writes it runs inside whatever pipeline the user pinned, while the tab that reads it is
// always the one from the installed extension. A build from a month-old task definition must
// still render, so:
//
//   * every field except `schema` and `task` is optional, and the tab must tolerate absence;
//   * `schema` is bumped only for a BREAKING change, never for an added field;
//   * nothing here is an enum the tab switches on exhaustively -- Argo CD adds health and
//     sync statuses between minors, and an unknown one must render as itself, not crash.
//
// SECURITY: this object is serialised to a file and published to the build, where anyone with
// read access can download it. The agent masks its own log stream, not files we write, so no
// field here may ever carry a credential. `publishRunAttachment` checks the serialised form
// against the secret registry before it is attached -- see ./secrets.

/** Attachment type registered with the agent. The tab queries builds for exactly this. */
export const RUN_ATTACHMENT_TYPE = 'argocd-tasks.run';

/** Bump ONLY for a breaking change. Added optional fields do not need a new version. */
export const RUN_SCHEMA_VERSION = 1;

/** One application, as shown in the main table. */
export interface AttachmentApplication {
    name: string;
    namespace?: string;
    project?: string;
    syncStatus?: string;
    healthStatus?: string;
    healthMessage?: string;
    operationPhase?: string;
    operationMessage?: string;
    /** Joined for display; `revisions` has the individual values. */
    revision?: string;
    /** One per source. A Helm chart source reports a chart version, not a SHA. */
    revisions?: string[];
    /** Deep link into the Argo CD UI. */
    url?: string;
}

/** A resource whose health is worth surfacing. */
export interface AttachmentResource {
    group?: string;
    kind?: string;
    namespace?: string;
    name?: string;
    health?: string;
    message?: string;
}

/** One resource's desired-vs-live difference, pre-rendered as a unified diff. */
export interface AttachmentDiff {
    group?: string;
    kind?: string;
    namespace?: string;
    name?: string;
    added: number;
    removed: number;
    /** Unified diff text. Empty when the resource was too large to render. */
    patch: string;
    truncated?: boolean;
}

/** A deployment-history entry. */
export interface AttachmentHistory {
    id?: number | string;
    revision?: string;
    deployedAt?: string;
    source?: string;
}

/** An application an ApplicationSet generated or would generate. */
export interface AttachmentGeneratedApp {
    name?: string;
    namespace?: string;
    project?: string;
    server?: string;
}

/**
 * A token, described WITHOUT its value.
 *
 * `id` is the client-generated UUID used to revoke the token. The JWT itself has no field
 * here and must never be given one -- that absence is the guarantee, not a convention.
 */
export interface AttachmentToken {
    id?: string;
    issuedAt?: number;
    expiresAt?: number;
    subject?: string;
}

export interface RunAttachment {
    schema: typeof RUN_SCHEMA_VERSION;
    /** e.g. "ArgoCDApp@1" -- what the tab groups and labels sections by. */
    task: string;
    command?: string;
    /** Step display name when the agent exposes one, for telling repeated steps apart. */
    step?: string;
    serverUrl?: string;
    startedAt?: string;
    finishedAt?: string;
    result?: 'Succeeded' | 'SucceededWithIssues' | 'Failed';
    /** Why the step failed, when it did. The failure case is when the tab matters most. */
    error?: string;
    applications?: AttachmentApplication[];
    unhealthy?: AttachmentResource[];
    diffs?: AttachmentDiff[];
    history?: AttachmentHistory[];
    generatedApps?: AttachmentGeneratedApp[];
    tokens?: AttachmentToken[];
    /** Free-form lines the tab renders verbatim, for commands with no richer shape. */
    notes?: string[];
}
