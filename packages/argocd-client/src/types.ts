// Narrow models of the Argo CD API.
//
// These cover only the fields this extension reads. The full swagger has 270 definitions;
// generating all of them to consume a dozen would bury the real contract in noise, and
// generated types would not catch a server-side semantic change anyway. Drift is caught
// instead by the swagger contract test, which asserts these paths and field names still
// exist in the pinned spec for the oldest supported minor.
//
// Anything the API may omit is optional here. Argo CD marshals with encoding/json and
// omitempty in several places, so "present in the docs" does not mean "present on the wire".

export type SyncStatusCode = 'Synced' | 'OutOfSync' | 'Unknown';

export type HealthStatusCode =
    | 'Healthy'
    | 'Progressing'
    | 'Degraded'
    | 'Suspended'
    | 'Missing'
    | 'Unknown';

export type OperationPhase = 'Running' | 'Terminating' | 'Failed' | 'Error' | 'Succeeded';

/** Values accepted by the `refresh` query parameter. */
export type RefreshType = 'normal' | 'hard';

export interface HealthStatus {
    status?: HealthStatusCode;
    message?: string;
}

export interface ObjectMeta {
    name?: string;
    namespace?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
}

export interface ResourceStatus {
    group?: string;
    version?: string;
    kind?: string;
    namespace?: string;
    name?: string;
    status?: SyncStatusCode;
    /**
     * Populated on single-application Get (the server infers it from the resource-tree
     * cache) but ABSENT on List since Argo CD 3.0, which stopped persisting per-resource
     * health in the Application CR. Never rely on this from a list response.
     */
    health?: HealthStatus;
    hook?: boolean;
    requiresPruning?: boolean;
}

export interface SyncOperationResult {
    revision?: string;
    revisions?: string[];
}

export interface OperationState {
    phase?: OperationPhase;
    message?: string;
    startedAt?: string;
    finishedAt?: string;
    syncResult?: SyncOperationResult;
}

/**
 * One entry of `status.history[]`.
 *
 * There is no history endpoint -- `argocd app history` simply reads this off the
 * application. It is never stripped by Get or List, but it IS capped by
 * `spec.revisionHistoryLimit` (default 10).
 */
export interface RevisionHistory {
    /** int64 on the wire, so it may arrive as a string. */
    id?: number | string;
    revision?: string;
    revisions?: string[];
    deployedAt?: string;
    deployStartedAt?: string;
    source?: { repoURL?: string; path?: string; targetRevision?: string; chart?: string };
    initiatedBy?: { username?: string; automated?: boolean };
}

export interface ApplicationStatus {
    sync?: { status?: SyncStatusCode; revision?: string; revisions?: string[] };
    /** The application-level rollup. Present on both Get and List. */
    health?: HealthStatus;
    operationState?: OperationState;
    resources?: ResourceStatus[];
    /** `appTree` from 3.0 onward, meaning per-resource health lives in the tree cache. */
    resourceHealthSource?: string;
    conditions?: Array<{ type?: string; message?: string }>;
    /** Deployment history, capped by spec.revisionHistoryLimit (default 10). */
    history?: RevisionHistory[];
}

export interface ApplicationSpec {
    project?: string;
    source?: { repoURL?: string; path?: string; targetRevision?: string };
    destination?: { server?: string; namespace?: string; name?: string };
    /**
     * Present when automated sync is enabled. Argo CD refuses to roll back such an
     * application, so `rollback` checks this before making a request.
     */
    syncPolicy?: {
        automated?: { prune?: boolean; selfHeal?: boolean; allowEmpty?: boolean };
        syncOptions?: string[];
    };
    revisionHistoryLimit?: number;
}

export interface Application {
    metadata?: ObjectMeta;
    spec?: ApplicationSpec;
    status?: ApplicationStatus;
}

export interface ApplicationList {
    metadata?: { resourceVersion?: string };
    items?: Application[];
}

/**
 * One entry from `managed-resources`.
 *
 * The four state fields are STRINGS CONTAINING JSON, not objects -- each must be
 * JSON.parse'd before use. This is the single easiest thing to get wrong about this
 * endpoint.
 */
export interface ResourceDiff {
    group?: string;
    kind?: string;
    namespace?: string;
    name?: string;
    targetState?: string;
    liveState?: string;
    normalizedLiveState?: string;
    predictedLiveState?: string;
    /** JSON patch between live and target. */
    diff?: string;
    hook?: boolean;
    modified?: boolean;
    resourceVersion?: string;
}

export interface ManagedResourcesResponse {
    items?: ResourceDiff[];
}

export interface ResourceNode {
    group?: string;
    version?: string;
    kind?: string;
    namespace?: string;
    name?: string;
    uid?: string;
    /** The authoritative per-resource health -- this is what Get infers from. */
    health?: HealthStatus;
    parentRefs?: Array<{ group?: string; kind?: string; namespace?: string; name?: string }>;
    images?: string[];
    createdAt?: string;
}

export interface ApplicationTree {
    nodes?: ResourceNode[];
    orphanedNodes?: ResourceNode[];
}

export interface UserInfo {
    loggedIn?: boolean;
    username?: string;
    iss?: string;
    groups?: string[];
}

/**
 * GET /api/version. Note this endpoint sits OUTSIDE /api/v1, and its fields are
 * PascalCase -- unusual for this API and an easy typing bug.
 */
export interface VersionMessage {
    Version?: string;
    BuildDate?: string;
    /** "<os>/<arch>", e.g. "linux/amd64". Decides whether the server can serve this agent a CLI binary. */
    Platform?: string;
    GitCommit?: string;
    GitTag?: string;
    KustomizeVersion?: string;
    HelmVersion?: string;
    KubectlVersion?: string;
}

export interface SyncOperationResource {
    group?: string;
    kind: string;
    name: string;
    namespace?: string;
}

export interface SyncStrategy {
    apply?: { force?: boolean };
    hook?: { syncStrategyApply?: { force?: boolean } };
}

export interface RetryStrategy {
    limit?: number;
    backoff?: { duration?: string; factor?: number; maxDuration?: string };
}

/** Request shape for POST /api/v1/applications/{name}/sync. */
export interface SyncRequest {
    revision?: string;
    prune?: boolean;
    dryRun?: boolean;
    strategy?: SyncStrategy;
    resources?: SyncOperationResource[];
    /**
     * Serialised as `{ "items": [...] }` on the wire -- a WRAPPER OBJECT, not a bare
     * array. Sending an array is silently ignored by the server, so a wrong sync option
     * fails open rather than erroring. The client owns this encoding; callers pass a
     * plain string[].
     */
    syncOptions?: string[];
    retryStrategy?: RetryStrategy;
    infos?: Array<{ name: string; value: string }>;
}

/**
 * A resource action offered by Argo CD, e.g. `restart` on a Deployment.
 *
 * `params` exposes only a NAME -- no type and no default value. The upstream doc comment
 * claiming otherwise is stale, so parameter values can only be supplied as raw strings.
 */
export interface ResourceAction {
    name?: string;
    displayName?: string;
    disabled?: boolean;
    iconClass?: string;
    params?: Array<{ name?: string }>;
}

export interface ResourceActionsListResponse {
    actions?: ResourceAction[];
}

/** Response of GET /api/v1/applications/{name}/manifests. */
export interface ManifestResponse {
    /** Each entry is a JSON-encoded manifest string, not an object and not YAML. */
    manifests?: string[];
    namespace?: string;
    server?: string;
    /** The revision actually resolved and rendered. */
    revision?: string;
    sourceType?: string;
    commands?: string[];
}

/** One log line from the streaming logs endpoint. */
export interface LogEntry {
    content?: string;
    /** Deprecated upstream in favour of timeStampStr, which keeps nanosecond precision. */
    timeStamp?: string;
    timeStampStr?: string;
    /** Marks the end of the stream when follow is off. */
    last?: boolean;
    podName?: string;
}

/** Identifies a single Kubernetes resource managed by an application. */
export interface ResourceRef {
    group?: string;
    kind: string;
    name: string;
    namespace?: string;
    version?: string;
}

// ---- Projects ----

/**
 * A token attached to a project role.
 *
 * NOTE the short field names: `iat` and `exp`, NOT `issuedAt`/`expiresAt`. The Account
 * service models the same concept with the long names, so the two must not share a type.
 * All three are int64 and arrive as JSON numbers.
 */
export interface JWTToken {
    id?: string;
    iat?: number;
    /** Absent or 0 means the token never expires. */
    exp?: number;
}

export interface ProjectRole {
    name?: string;
    description?: string;
    policies?: string[];
    groups?: string[];
    jwtTokens?: JWTToken[];
}

export interface AppProjectSpec {
    description?: string;
    sourceRepos?: string[];
    destinations?: Array<{ server?: string; namespace?: string; name?: string }>;
    roles?: ProjectRole[];
}

export interface AppProject {
    metadata?: ObjectMeta;
    spec?: AppProjectSpec;
}

export interface AppProjectList {
    items?: AppProject[];
}

/** Response of project and account token creation. Carries the token and NOTHING else. */
export interface TokenResponse {
    token?: string;
}

// ---- Accounts ----

/**
 * A token on a local account.
 *
 * NOTE the long field names here, in contrast to the project-side JWTToken.
 */
export interface AccountToken {
    id?: string;
    issuedAt?: number;
    expiresAt?: number;
}

export interface Account {
    name?: string;
    enabled?: boolean;
    /** Token creation requires "apiKey" to be present, configured in argocd-cm. */
    capabilities?: string[];
    tokens?: AccountToken[];
}

export interface AccountList {
    items?: Account[];
}

/** Response of can-i. `value` is the STRING "yes" or "no", not a boolean. */
export interface CanIResponse {
    value?: string;
}

// ---- ApplicationSets ----

export interface ApplicationSetSpec {
    generators?: Array<Record<string, unknown>>;
    template?: Record<string, unknown>;
    /**
     * `preserveResourcesOnDeletion` decides whether deleting the ApplicationSet also
     * deletes every Application it generated. Absent or false means the Applications go
     * with it -- which is why the delete command reports this before acting.
     */
    syncPolicy?: { preserveResourcesOnDeletion?: boolean; applicationsSync?: string };
}

export interface ApplicationSetStatus {
    conditions?: Array<{ type?: string; status?: string; message?: string }>;
    resources?: Array<{ name?: string; namespace?: string; kind?: string; group?: string }>;
}

export interface ApplicationSet {
    metadata?: ObjectMeta;
    spec?: ApplicationSetSpec;
    status?: ApplicationSetStatus;
}

export interface ApplicationSetList {
    items?: ApplicationSet[];
}

/** Response of the generate (preview) endpoint: the rendered Applications, nothing persisted. */
export interface ApplicationSetGenerateResponse {
    applications?: Application[];
}

/**
 * Every revision the object carries, one per application source.
 *
 * Argo CD writes the revision into ONE of two fields depending on the application's shape,
 * and leaves the other empty:
 *
 *   - single-source app (`spec.source`)   -> `revision`  (a string)
 *   - multi-source app  (`spec.sources`)  -> `revisions` (one entry per source, in order)
 *
 * Both fields exist on `status.sync`, `status.operationState.syncResult` and every
 * `status.history[]` entry -- see v1alpha1SyncStatus, v1alpha1SyncOperationResult and
 * v1alpha1RevisionHistory in vendor/swagger/argocd.json. Reading only the singular means
 * every multi-source application reports an empty revision, with nothing to indicate why.
 *
 * The plural wins when both are set: for a multi-source app the singular can only ever hold
 * one of several, so preferring it would silently drop the rest.
 *
 * Entries are NOT all git SHAs. A Helm chart source reports its chart version, so the common
 * "chart from a registry + values from a repo" application yields something like
 * `["1.2.3", "<sha>"]`.
 */
export function revisionsOf(value: { revision?: string; revisions?: string[] } | undefined): string[] {
    if (value === undefined) {
        return [];
    }
    const many = (value.revisions ?? []).filter((r) => r !== undefined && r !== '');
    if (many.length > 0) {
        return many;
    }
    return value.revision !== undefined && value.revision !== '' ? [value.revision] : [];
}

/**
 * The deployed revision as a single string, comma-separated for a multi-source application.
 *
 * Use `revisionsOf` when the individual values matter -- see the note there about Helm chart
 * sources reporting a chart version rather than a SHA.
 */
export function revisionOf(value: { revision?: string; revisions?: string[] } | undefined): string | undefined {
    const many = revisionsOf(value);
    return many.length === 0 ? undefined : many.join(',');
}
