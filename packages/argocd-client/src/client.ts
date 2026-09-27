// Typed client for the Argo CD REST API (grpc-gateway, /api/v1/...).
//
// Everything awkward about this API is encoded here rather than left to callers:
//
//   * `project` is a REPEATED param on get/list but a SINGULAR string on sync,
//     managed-resources, resource-tree and terminate. They cannot share a query builder.
//   * If both `project` and `projects` are sent, the server SILENTLY IGNORES `projects`.
//     This client never sends both.
//   * `syncOptions` goes on the wire as `{ "items": [...] }`. A bare array is silently
//     ignored, so a mistake here fails open.
//   * `refresh` must be OMITTED entirely to mean "no refresh". Present-but-empty still
//     triggers a refresh, and a refreshing Get BLOCKS until the controller clears the
//     annotation -- hence a separate, much larger timeout for those calls.
//   * `fields` is not supported. It is absent from the proto and swagger, and
//     grpc-gateway v1 silently drops unknown query params. The Argo CD UI sends it
//     anyway, which is a good way to be misled.

import { errorFromResponse, ArgoCdApiError, GrpcCode } from './errors';
import { LogStreamResult, parseLogStream } from './logs';
import { computeBackoffMs, DEFAULT_RETRY, isRetryableStatus, isRetryableTransportError, RetryOptions } from './retry';
import { HttpMethod, HttpRequest, Transport, TransportError } from './transport';
import {
    Account,
    AccountList,
    AppProject,
    AppProjectList,
    Application,
    ApplicationSet,
    ApplicationSetGenerateResponse,
    ApplicationSetList,
    ApplicationList,
    ApplicationTree,
    ManagedResourcesResponse,
    ManifestResponse,
    RefreshType,
    ResourceActionsListResponse,
    ResourceRef,
    CanIResponse,
    SyncRequest,
    TokenResponse,
    UserInfo,
    VersionMessage,
} from './types';

export interface ArgoCdClientOptions {
    /** Server base URL. A sub-path (https://host/argocd) is preserved. */
    serverUrl: string;
    token?: string | undefined;
    transport: Transport;
    /** Timeout for ordinary calls. */
    timeoutMs?: number;
    /**
     * Timeout for calls that carry `refresh`. A hard refresh blocks server-side until
     * the application controller has reconciled, which can take minutes on a large app.
     */
    refreshTimeoutMs?: number;
    retry?: Partial<RetryOptions>;
    /** Extra headers, e.g. for an authenticating reverse proxy in front of Argo CD. */
    extraHeaders?: Record<string, string>;
    userAgent?: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_REFRESH_TIMEOUT_MS = 300_000;

interface QueryValue {
    key: string;
    value: string;
}

/** Query params for Get/List, where `project` is repeated. */
export interface ApplicationQuery {
    appNamespace?: string | undefined;
    project?: string | undefined;
    projects?: string[] | undefined;
    refresh?: RefreshType | undefined;
    selector?: string | undefined;
    repo?: string | undefined;
}

/** Query params for the resource endpoints, where `project` is a single string. */
export interface ResourceQuery {
    appNamespace?: string | undefined;
    project?: string | undefined;
}

export class ArgoCdClient {
    private readonly baseUrl: string;
    private readonly token: string | undefined;
    private readonly transport: Transport;
    private readonly timeoutMs: number;
    private readonly refreshTimeoutMs: number;
    private readonly retry: RetryOptions;
    private readonly extraHeaders: Record<string, string>;
    private readonly userAgent: string;

    public constructor(options: ArgoCdClientOptions) {
        this.baseUrl = normaliseBaseUrl(options.serverUrl);
        this.token = options.token;
        this.transport = options.transport;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.refreshTimeoutMs = options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
        this.retry = { ...DEFAULT_RETRY, ...options.retry };
        this.extraHeaders = options.extraHeaders ?? {};
        this.userAgent = options.userAgent ?? 'azdo-argocd-tasks';
    }

    /** GET /api/v1/applications/{name} */
    public async getApplication(name: string, query: ApplicationQuery = {}): Promise<Application> {
        return this.request<Application>({
            method: 'GET',
            path: `/api/v1/applications/${encodeURIComponent(name)}`,
            query: buildApplicationQuery(query),
            projectSupplied: query.project !== undefined,
            timeoutMs: query.refresh === undefined ? this.timeoutMs : this.refreshTimeoutMs,
        });
    }

    /**
     * GET /api/v1/applications
     *
     * Note `status.resources[].health` is ABSENT from list responses on Argo CD 3.x.
     * The application-level `status.health.status` rollup IS present, so gating on
     * overall health across many apps does not need an extra call per app.
     */
    public async listApplications(query: ApplicationQuery = {}): Promise<ApplicationList> {
        return this.request<ApplicationList>({
            method: 'GET',
            path: '/api/v1/applications',
            query: buildApplicationQuery(query),
            projectSupplied: query.project !== undefined || (query.projects ?? []).length > 0,
            timeoutMs: query.refresh === undefined ? this.timeoutMs : this.refreshTimeoutMs,
        });
    }

    /** POST /api/v1/applications/{name}/sync */
    public async syncApplication(
        name: string,
        body: SyncRequest,
        query: ResourceQuery = {},
    ): Promise<Application> {
        return this.request<Application>({
            method: 'POST',
            path: `/api/v1/applications/${encodeURIComponent(name)}/sync`,
            query: [],
            body: encodeSyncBody(name, body, query),
            projectSupplied: query.project !== undefined,
            timeoutMs: this.timeoutMs,
        });
    }

    /** GET /api/v1/applications/{name}/managed-resources -- the data behind a diff. */
    public async getManagedResources(
        name: string,
        query: ResourceQuery = {},
    ): Promise<ManagedResourcesResponse> {
        return this.request<ManagedResourcesResponse>({
            method: 'GET',
            path: `/api/v1/applications/${encodeURIComponent(name)}/managed-resources`,
            query: buildResourceQuery(query),
            projectSupplied: query.project !== undefined,
            timeoutMs: this.timeoutMs,
        });
    }

    /** GET /api/v1/applications/{name}/resource-tree -- authoritative per-resource health. */
    public async getResourceTree(name: string, query: ResourceQuery = {}): Promise<ApplicationTree> {
        return this.request<ApplicationTree>({
            method: 'GET',
            path: `/api/v1/applications/${encodeURIComponent(name)}/resource-tree`,
            query: buildResourceQuery(query),
            projectSupplied: query.project !== undefined,
            timeoutMs: this.timeoutMs,
        });
    }

    /** DELETE (not POST) /api/v1/applications/{name}/operation */
    public async terminateOperation(name: string, query: ResourceQuery = {}): Promise<void> {
        await this.request<unknown>({
            method: 'DELETE',
            path: `/api/v1/applications/${encodeURIComponent(name)}/operation`,
            query: buildResourceQuery(query),
            projectSupplied: query.project !== undefined,
            timeoutMs: this.timeoutMs,
        });
    }

    /**
     * GET /api/v1/session/userinfo -- the connection probe.
     *
     * Better than /api/version for testing a connection because it reflects the token:
     * it returns `loggedIn: false` for a bad token rather than erroring, so a failure
     * here is unambiguously a connectivity problem.
     */
    public async getUserInfo(): Promise<UserInfo> {
        return this.request<UserInfo>({
            method: 'GET',
            path: '/api/v1/session/userinfo',
            query: [],
            projectSupplied: false,
            timeoutMs: this.timeoutMs,
        });
    }

    /** GET /api/version -- outside /api/v1, and the response fields are PascalCase. */
    public async getVersion(): Promise<VersionMessage> {
        return this.request<VersionMessage>({
            method: 'GET',
            path: '/api/version',
            query: [],
            projectSupplied: false,
            timeoutMs: this.timeoutMs,
        });
    }

    /**
     * POST /api/v1/applications/{name}/rollback
     *
     * Rollback is sugar over sync: it sets an operation and returns immediately, so the
     * caller must poll for the outcome exactly as it would after a sync.
     */
    public async rollbackApplication(
        name: string,
        body: { id: number; prune?: boolean; dryRun?: boolean },
        query: ResourceQuery = {},
    ): Promise<Application> {
        try {
            return await this.request<Application>({
                method: 'POST',
                path: `/api/v1/applications/${encodeURIComponent(name)}/rollback`,
                query: [],
                body: encodeRollbackBody(name, body, query),
                projectSupplied: query.project !== undefined,
                timeoutMs: this.timeoutMs,
            });
        } catch (error) {
            throw explainRollbackFailure(error);
        }
    }

    /**
     * GET /api/v1/applications/{name}/manifests
     *
     * Returns DESIRED (git) manifests only. "Live" manifests are not a mode of this
     * endpoint -- the CLI implements `--source live` by reading `liveState` out of
     * managed-resources, which getManagedResources already provides.
     */
    public async getManifests(
        name: string,
        options: { revision?: string | undefined; noCache?: boolean | undefined } = {},
        query: ResourceQuery = {},
    ): Promise<ManifestResponse> {
        const params = buildResourceQuery(query);
        if (options.revision !== undefined && options.revision !== '') {
            params.push({ key: 'revision', value: options.revision });
        }
        if (options.noCache === true) {
            params.push({ key: 'noCache', value: 'true' });
        }
        return this.request<ManifestResponse>({
            method: 'GET',
            path: `/api/v1/applications/${encodeURIComponent(name)}/manifests`,
            query: params,
            projectSupplied: query.project !== undefined,
            timeoutMs: this.timeoutMs,
        });
    }

    /** GET /api/v1/applications/{name}/resource/actions */
    public async listResourceActions(
        name: string,
        resource: ResourceRef,
        query: ResourceQuery = {},
    ): Promise<ResourceActionsListResponse> {
        return this.request<ResourceActionsListResponse>({
            method: 'GET',
            path: `/api/v1/applications/${encodeURIComponent(name)}/resource/actions`,
            query: [...buildResourceQuery(query), ...buildResourceRefQuery(resource)],
            projectSupplied: query.project !== undefined,
            timeoutMs: this.timeoutMs,
        });
    }

    /**
     * POST /api/v1/applications/{name}/resource/actions/v2
     *
     * V2 only. It landed in Argo CD 3.1, which is below this extension's supported floor
     * of 3.3, so a V1 fallback would be dead code that no test could reach. A 404 here
     * therefore means the server predates 3.1 and is unsupported, and says so.
     *
     * The action runs a Lua script server-side and is NOT transactional -- a failure can
     * leave some resources changed. The response is an empty object either way.
     */
    public async runResourceAction(
        name: string,
        body: { action: string; parameters?: Array<{ name: string; value: string }>; resource: ResourceRef },
        query: ResourceQuery = {},
    ): Promise<void> {
        try {
            await this.request<unknown>({
                method: 'POST',
                path: `/api/v1/applications/${encodeURIComponent(name)}/resource/actions/v2`,
                query: [],
                body: encodeRunActionBody(name, body, query),
                projectSupplied: query.project !== undefined,
                timeoutMs: this.timeoutMs,
            });
        } catch (error) {
            if (error instanceof ArgoCdApiError && error.isNotFound) {
                throw new ArgoCdApiError({
                    message: error.message,
                    httpStatus: error.httpStatus,
                    grpcCode: error.grpcCode,
                    method: error.method,
                    path: error.path,
                    hint:
                        'This server does not provide the resource-action v2 endpoint, which was ' +
                        'added in Argo CD 3.1. Check the application, resource and action names; if ' +
                        'they are right, the server predates the supported version range (3.3+).',
                });
            }
            throw error;
        }
    }

    /**
     * GET /api/v1/applications/{name}/logs
     *
     * Follow mode is deliberately not supported: a following stream never terminates, and
     * a pipeline task that never returns is worse than one that returns bounded output.
     */
    public async getPodLogs(
        name: string,
        options: {
            resource?: ResourceRef | undefined;
            podName?: string | undefined;
            container?: string | undefined;
            tailLines?: number | undefined;
            sinceSeconds?: number | undefined;
            previous?: boolean | undefined;
            filter?: string | undefined;
        } = {},
        query: ResourceQuery = {},
    ): Promise<LogStreamResult> {
        const params = buildResourceQuery(query);

        if (options.podName !== undefined && options.podName !== '') {
            // Setting podName makes the server infer kind=Pod, so never send both.
            params.push({ key: 'podName', value: options.podName });
        } else if (options.resource !== undefined) {
            params.push(...buildResourceRefQuery(options.resource));
        }

        if (options.container !== undefined && options.container !== '') {
            params.push({ key: 'container', value: options.container });
        }
        // int64 fields: string on the wire. Zero is the same as omitting, so skip it.
        if (options.tailLines !== undefined && options.tailLines > 0) {
            params.push({ key: 'tailLines', value: String(options.tailLines) });
        }
        if (options.sinceSeconds !== undefined && options.sinceSeconds > 0) {
            params.push({ key: 'sinceSeconds', value: String(options.sinceSeconds) });
        }
        if (options.previous === true) {
            params.push({ key: 'previous', value: 'true' });
        }
        if (options.filter !== undefined && options.filter !== '') {
            params.push({ key: 'filter', value: options.filter });
        }
        params.push({ key: 'follow', value: 'false' });

        const path = `/api/v1/applications/${encodeURIComponent(name)}/logs`;
        const body = await this.requestRaw({
            method: 'GET',
            path,
            query: params,
            projectSupplied: query.project !== undefined,
            timeoutMs: this.timeoutMs,
        });
        return parseLogStream(body, { path });
    }

    /**
     * POST /api/v1/applications
     *
     * `upsert` and `validate` are QUERY parameters, not body fields, and the body is the
     * bare Application rather than an envelope. `validate` defaults to true server-side.
     * Creating an identical application is idempotent; creating a different one without
     * `upsert` is rejected. Note `upsert: true` triggers a SECOND RBAC check for `update`,
     * so a create-only token will be denied at that point.
     */
    public async createApplication(
        application: Record<string, unknown>,
        options: { upsert?: boolean | undefined; validate?: boolean | undefined } = {},
    ): Promise<Application> {
        const params: QueryValue[] = [];
        if (options.upsert === true) {
            params.push({ key: 'upsert', value: 'true' });
        }
        if (options.validate === false) {
            params.push({ key: 'validate', value: 'false' });
        }
        return this.request<Application>({
            method: 'POST',
            path: '/api/v1/applications',
            query: params,
            body: JSON.stringify(application),
            projectSupplied: true,
            timeoutMs: this.timeoutMs,
        });
    }

    /**
     * PUT /api/v1/applications/{name}/spec -- a FULL REPLACE of the spec.
     *
     * The server overwrites .spec wholesale, so the body must be the COMPLETE spec: any
     * field omitted is deleted. Callers must read-modify-write, never reconstruct.
     *
     * No resourceVersion travels with this request, so there is no optimistic concurrency:
     * two pipelines editing one application will clobber each other. Keep the read-write
     * window short.
     *
     * Returns the spec as stored AFTER server-side normalization, which is what should be
     * reported rather than the request body.
     */
    public async updateApplicationSpec(
        name: string,
        spec: Record<string, unknown>,
        options: { validate?: boolean | undefined } = {},
        query: ResourceQuery = {},
    ): Promise<Record<string, unknown>> {
        const params = buildResourceQuery(query);
        if (options.validate === false) {
            params.push({ key: 'validate', value: 'false' });
        }
        return this.request<Record<string, unknown>>({
            method: 'PUT',
            path: `/api/v1/applications/${encodeURIComponent(name)}/spec`,
            query: params,
            body: JSON.stringify(spec),
            projectSupplied: query.project !== undefined,
            timeoutMs: this.timeoutMs,
        });
    }

    /**
     * DELETE /api/v1/applications/{name}
     *
     * Deletion is ASYNCHRONOUS: this returns as soon as the finalizer is set, and the
     * object lingers while the controller reaps its children.
     *
     * `cascade` defaults to true server-side when omitted, and sending `cascade=false`
     * together with a propagation policy is rejected -- so the two are never emitted
     * together here.
     */
    public async deleteApplication(
        name: string,
        options: { cascade?: boolean | undefined; propagationPolicy?: string | undefined } = {},
        query: ResourceQuery = {},
    ): Promise<void> {
        const params = buildResourceQuery(query);
        const cascade = options.cascade !== false;

        if (!cascade) {
            params.push({ key: 'cascade', value: 'false' });
        } else {
            if (options.cascade !== undefined) {
                params.push({ key: 'cascade', value: 'true' });
            }
            if (options.propagationPolicy !== undefined && options.propagationPolicy !== '') {
                params.push({ key: 'propagationPolicy', value: options.propagationPolicy });
            }
        }

        await this.request<unknown>({
            method: 'DELETE',
            path: `/api/v1/applications/${encodeURIComponent(name)}`,
            query: params,
            projectSupplied: query.project !== undefined,
            timeoutMs: this.timeoutMs,
        });
    }

    // ---- Projects ----

    /** GET /api/v1/projects/{name} */
    public async getProject(name: string): Promise<AppProject> {
        return this.request<AppProject>({
            method: 'GET',
            path: `/api/v1/projects/${encodeURIComponent(name)}`,
            query: [],
            projectSupplied: true,
            timeoutMs: this.timeoutMs,
        });
    }

    /**
     * GET /api/v1/projects
     *
     * The server IGNORES the documented `name` query parameter -- the handler discards the
     * request entirely -- so this never accepts one. Use getProject to fetch one project.
     */
    public async listProjects(): Promise<AppProjectList> {
        return this.request<AppProjectList>({
            method: 'GET',
            path: '/api/v1/projects',
            query: [],
            projectSupplied: true,
            timeoutMs: this.timeoutMs,
        });
    }

    /**
     * POST /api/v1/projects/{project}/roles/{role}/token
     *
     * The response contains the token and nothing else -- no id. Always pass an explicit
     * `id` so the handle for revocation is known without decoding the JWT.
     *
     * `expiresInSeconds` is an int64 on the wire: a JSON number of SECONDS. Zero (or
     * omitted) means the token NEVER EXPIRES.
     */
    public async createProjectToken(
        project: string,
        role: string,
        options: { expiresInSeconds?: number | undefined; id?: string | undefined } = {},
    ): Promise<TokenResponse> {
        const payload: Record<string, unknown> = { project, role };
        if (options.expiresInSeconds !== undefined) {
            payload['expiresIn'] = options.expiresInSeconds;
        }
        if (options.id !== undefined && options.id !== '') {
            payload['id'] = options.id;
        }
        return this.request<TokenResponse>({
            method: 'POST',
            path: `/api/v1/projects/${encodeURIComponent(project)}/roles/${encodeURIComponent(role)}/token`,
            query: [],
            body: JSON.stringify(payload),
            projectSupplied: true,
            timeoutMs: this.timeoutMs,
        });
    }

    /**
     * DELETE /api/v1/projects/{project}/roles/{role}/token/{iat}?id=...
     *
     * `iat` is a required path segment, and -1 is the sentinel that disables matching by
     * issued-at so the token is found by id alone. The server's guard is `issuedAt != -1`,
     * so 0 would NOT disable it.
     *
     * Beware: this returns HTTP 200 even when it deleted nothing -- a wrong role name or a
     * non-existent id both look like success. Callers must verify by re-reading the project.
     */
    public async deleteProjectToken(project: string, role: string, id: string): Promise<void> {
        await this.request<unknown>({
            method: 'DELETE',
            path:
                `/api/v1/projects/${encodeURIComponent(project)}/roles/${encodeURIComponent(role)}` +
                `/token/-1`,
            query: [{ key: 'id', value: id }],
            projectSupplied: true,
            timeoutMs: this.timeoutMs,
        });
    }

    // ---- Accounts ----

    /** GET /api/v1/account */
    public async listAccounts(): Promise<AccountList> {
        return this.request<AccountList>({
            method: 'GET',
            path: '/api/v1/account',
            query: [],
            projectSupplied: true,
            timeoutMs: this.timeoutMs,
        });
    }

    /** GET /api/v1/account/{name} -- includes the account's token metadata. */
    public async getAccount(name: string): Promise<Account> {
        return this.request<Account>({
            method: 'GET',
            path: `/api/v1/account/${encodeURIComponent(name)}`,
            query: [],
            projectSupplied: true,
            timeoutMs: this.timeoutMs,
        });
    }

    /**
     * POST /api/v1/account/{name}/token
     *
     * As with project tokens, the response carries only the token. The account must have
     * the `apiKey` capability, which is configured in argocd-cm and cannot be set via the
     * API; that failure is wrapped server-side and loses its status code, so it is mapped
     * to something actionable here.
     */
    public async createAccountToken(
        name: string,
        options: { expiresInSeconds?: number | undefined; id?: string | undefined } = {},
    ): Promise<TokenResponse> {
        const payload: Record<string, unknown> = { name };
        if (options.expiresInSeconds !== undefined) {
            payload['expiresIn'] = options.expiresInSeconds;
        }
        if (options.id !== undefined && options.id !== '') {
            payload['id'] = options.id;
        }
        try {
            return await this.request<TokenResponse>({
                method: 'POST',
                path: `/api/v1/account/${encodeURIComponent(name)}/token`,
                query: [],
                body: JSON.stringify(payload),
                projectSupplied: true,
                timeoutMs: this.timeoutMs,
            });
        } catch (error) {
            throw explainAccountTokenFailure(error, name);
        }
    }

    /** DELETE /api/v1/account/{name}/token/{id} -- by id, and it does report NotFound. */
    public async deleteAccountToken(name: string, id: string): Promise<void> {
        await this.request<unknown>({
            method: 'DELETE',
            path: `/api/v1/account/${encodeURIComponent(name)}/token/${encodeURIComponent(id)}`,
            query: [],
            projectSupplied: true,
            timeoutMs: this.timeoutMs,
        });
    }

    /**
     * GET /api/v1/account/can-i/{resource}/{action}/{subresource}
     *
     * The subresource is a MULTI-SEGMENT wildcard, so "payments/api" must appear as two
     * real path segments. Percent-encoding it breaks the route, which is why the path is
     * built by concatenation here rather than with encodeURIComponent.
     *
     * Note the path order is resource-then-action, while the CLI reads action-then-resource.
     */
    public async canI(resource: string, action: string, subresource: string): Promise<boolean> {
        const response = await this.request<CanIResponse>({
            method: 'GET',
            path: buildCanIPath(resource, action, subresource),
            query: [],
            projectSupplied: true,
            timeoutMs: this.timeoutMs,
        });
        // The server answers with the STRING "yes" or "no", not a boolean.
        return response.value === 'yes';
    }

    // ---- ApplicationSets ----
    //
    // A NOTE ON BODY SHAPES, because the two POSTs in this service disagree and the
    // inconsistency looks like a mistake worth "tidying up":
    //
    //   POST /applicationsets           -> the body is the BARE ApplicationSet,
    //                                      and upsert/dryRun are QUERY parameters.
    //   POST /applicationsets/generate  -> the body is WRAPPED as {"applicationSet": ...},
    //                                      with a capital S, unlike the lowercase
    //                                      "applicationset" used elsewhere.
    //
    // Both forms are load-bearing. Making them consistent breaks one of them.

    /** GET /api/v1/applicationsets */
    public async listApplicationSets(
        query: {
            projects?: string[] | undefined;
            selector?: string | undefined;
            appsetNamespace?: string | undefined;
        } = {},
    ): Promise<ApplicationSetList> {
        const params: QueryValue[] = [];
        for (const project of query.projects ?? []) {
            if (project !== '') {
                params.push({ key: 'projects', value: project });
            }
        }
        if (query.selector !== undefined && query.selector !== '') {
            params.push({ key: 'selector', value: query.selector });
        }
        if (query.appsetNamespace !== undefined && query.appsetNamespace !== '') {
            params.push({ key: 'appsetNamespace', value: query.appsetNamespace });
        }
        return this.request<ApplicationSetList>({
            method: 'GET',
            path: '/api/v1/applicationsets',
            query: params,
            projectSupplied: (query.projects ?? []).length > 0,
            timeoutMs: this.timeoutMs,
        });
    }

    /** GET /api/v1/applicationsets/{name} */
    public async getApplicationSet(
        name: string,
        query: { appsetNamespace?: string | undefined } = {},
    ): Promise<ApplicationSet> {
        const params: QueryValue[] = [];
        if (query.appsetNamespace !== undefined && query.appsetNamespace !== '') {
            params.push({ key: 'appsetNamespace', value: query.appsetNamespace });
        }
        return this.request<ApplicationSet>({
            method: 'GET',
            path: `/api/v1/applicationsets/${encodeURIComponent(name)}`,
            query: params,
            projectSupplied: true,
            timeoutMs: this.timeoutMs,
        });
    }

    /**
     * POST /api/v1/applicationsets
     *
     * The body is the BARE ApplicationSet -- not wrapped -- and `upsert`/`dryRun` are query
     * parameters. There is also no `appsetNamespace` parameter here, uniquely among these
     * operations: the namespace comes from the body's metadata.namespace.
     *
     * `dryRun` is NOT the same as generate. It returns the ApplicationSet with
     * status.resources populated ("what would this own?") and persists nothing, whereas
     * generate returns the rendered Applications ("what would this produce?").
     */
    public async createApplicationSet(
        applicationSet: Record<string, unknown>,
        options: { upsert?: boolean | undefined; dryRun?: boolean | undefined } = {},
    ): Promise<ApplicationSet> {
        const params: QueryValue[] = [];
        if (options.upsert === true) {
            params.push({ key: 'upsert', value: 'true' });
        }
        if (options.dryRun === true) {
            params.push({ key: 'dryRun', value: 'true' });
        }
        return this.request<ApplicationSet>({
            method: 'POST',
            path: '/api/v1/applicationsets',
            query: params,
            body: JSON.stringify(applicationSet),
            projectSupplied: true,
            timeoutMs: this.timeoutMs,
        });
    }

    /** DELETE /api/v1/applicationsets/{name}. Returns an empty object; nothing to parse. */
    public async deleteApplicationSet(
        name: string,
        query: { appsetNamespace?: string | undefined } = {},
    ): Promise<void> {
        const params: QueryValue[] = [];
        if (query.appsetNamespace !== undefined && query.appsetNamespace !== '') {
            params.push({ key: 'appsetNamespace', value: query.appsetNamespace });
        }
        await this.request<unknown>({
            method: 'DELETE',
            path: `/api/v1/applicationsets/${encodeURIComponent(name)}`,
            query: params,
            projectSupplied: true,
            timeoutMs: this.timeoutMs,
        });
    }

    /**
     * POST /api/v1/applicationsets/generate -- render the Applications without persisting.
     *
     * The body is WRAPPED as {"applicationSet": ...} with a capital S. Errors from this
     * endpoint carry the generator's log buffer appended to the message, which can be long
     * and may contain repository URLs, so callers should truncate before surfacing it.
     */
    public async generateApplicationSet(
        applicationSet: Record<string, unknown>,
    ): Promise<ApplicationSetGenerateResponse> {
        return this.request<ApplicationSetGenerateResponse>({
            method: 'POST',
            path: '/api/v1/applicationsets/generate',
            query: [],
            body: JSON.stringify({ applicationSet }),
            projectSupplied: true,
            timeoutMs: this.timeoutMs,
        });
    }

    private async request<T>(args: {
        method: HttpMethod;
        path: string;
        query: QueryValue[];
        body?: string;
        projectSupplied: boolean;
        timeoutMs: number;
        raw?: boolean;
    }): Promise<T> {
        const isWrite = args.method !== 'GET';
        const url = this.buildUrl(args.path, args.query);
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'User-Agent': this.userAgent,
            ...this.extraHeaders,
        };
        if (this.token !== undefined && this.token !== '') {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        if (isWrite) {
            // Every non-GET needs a Content-Type, INCLUDING bodyless DELETEs. Argo CD
            // wraps the gateway in enforceContentTypes, which rejects them with a bare
            // HTTP 415 before the handler runs -- verified against a live 3.5.3 server:
            // DELETE .../operation returns 415 without this header and 400 with it.
            headers['Content-Type'] = 'application/json';
        }
        if (args.body !== undefined) {
            headers['Content-Length'] = String(Buffer.byteLength(args.body, 'utf8'));
        }

        const request: HttpRequest = {
            method: args.method,
            url,
            headers,
            timeoutMs: args.timeoutMs,
            ...(args.body === undefined ? {} : { body: args.body }),
        };

        let lastError: unknown;
        for (let attempt = 0; attempt < this.retry.maxAttempts; attempt += 1) {
            if (attempt > 0) {
                await this.retry.sleep(computeBackoffMs(attempt - 1, this.retry));
            }

            let response;
            try {
                response = await this.transport(request);
            } catch (error) {
                if (
                    error instanceof TransportError &&
                    isRetryableTransportError(error, isWrite) &&
                    attempt < this.retry.maxAttempts - 1
                ) {
                    lastError = error;
                    continue;
                }
                throw error;
            }

            if (response.status >= 200 && response.status < 300) {
                return args.raw === true ? (response.body as unknown as T) : parseJsonBody<T>(response.body);
            }

            if (isRetryableStatus(response.status, isWrite) && attempt < this.retry.maxAttempts - 1) {
                lastError = errorFromResponse({
                    status: response.status,
                    body: response.body,
                    method: args.method,
                    path: args.path,
                    projectSupplied: args.projectSupplied,
                });
                continue;
            }

            throw errorFromResponse({
                status: response.status,
                body: response.body,
                method: args.method,
                path: args.path,
                projectSupplied: args.projectSupplied,
            });
        }

        throw lastError instanceof Error
            ? lastError
            : new ArgoCdApiError({
                  message: 'Argo CD request failed after exhausting retries',
                  httpStatus: 0,
                  method: args.method,
                  path: args.path,
              });
    }

    /** Like request(), but hands back the raw body -- the log stream is NDJSON, not JSON. */
    private async requestRaw(args: {
        method: HttpMethod;
        path: string;
        query: QueryValue[];
        projectSupplied: boolean;
        timeoutMs: number;
    }): Promise<string> {
        return this.request<string>({ ...args, raw: true });
    }

    private buildUrl(path: string, query: QueryValue[]): string {
        const search = query
            .map(({ key, value }) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
            .join('&');
        return `${this.baseUrl}${path}${search === '' ? '' : `?${search}`}`;
    }
}

/** Strip the trailing slash so `${base}/api/v1/...` is always well formed, sub-path installs included. */
export function normaliseBaseUrl(serverUrl: string): string {
    const trimmed = serverUrl.trim();
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return withScheme.replace(/\/+$/, '');
}

/**
 * Query for Get/List.
 *
 * `project` wins over `projects` and they are never sent together, mirroring the
 * server's own precedence (it reads Project first and ignores Projects when set).
 */
export function buildApplicationQuery(query: ApplicationQuery): QueryValue[] {
    const params: QueryValue[] = [];
    if (query.appNamespace !== undefined && query.appNamespace !== '') {
        params.push({ key: 'appNamespace', value: query.appNamespace });
    }
    if (query.project !== undefined && query.project !== '') {
        params.push({ key: 'project', value: query.project });
    } else {
        for (const project of query.projects ?? []) {
            if (project !== '') {
                params.push({ key: 'projects', value: project });
            }
        }
    }
    if (query.selector !== undefined && query.selector !== '') {
        params.push({ key: 'selector', value: query.selector });
    }
    if (query.repo !== undefined && query.repo !== '') {
        params.push({ key: 'repo', value: query.repo });
    }
    // Only ever present when a refresh is actually wanted: an empty value still refreshes.
    if (query.refresh !== undefined) {
        params.push({ key: 'refresh', value: query.refresh });
    }
    return params;
}

/** Query for the resource endpoints, where `project` is singular. */
export function buildResourceQuery(query: ResourceQuery): QueryValue[] {
    const params: QueryValue[] = [];
    if (query.appNamespace !== undefined && query.appNamespace !== '') {
        params.push({ key: 'appNamespace', value: query.appNamespace });
    }
    if (query.project !== undefined && query.project !== '') {
        params.push({ key: 'project', value: query.project });
    }
    return params;
}

/** Encode a sync request, wrapping syncOptions the way the server expects. */
export function encodeSyncBody(name: string, body: SyncRequest, query: ResourceQuery): string {
    const payload: Record<string, unknown> = { name };
    if (query.appNamespace !== undefined && query.appNamespace !== '') {
        payload['appNamespace'] = query.appNamespace;
    }
    if (query.project !== undefined && query.project !== '') {
        payload['project'] = query.project;
    }
    if (body.revision !== undefined && body.revision !== '') {
        payload['revision'] = body.revision;
    }
    if (body.prune !== undefined) {
        payload['prune'] = body.prune;
    }
    if (body.dryRun !== undefined) {
        payload['dryRun'] = body.dryRun;
    }
    if (body.strategy !== undefined) {
        payload['strategy'] = body.strategy;
    }
    if (body.resources !== undefined && body.resources.length > 0) {
        payload['resources'] = body.resources;
    }
    if (body.retryStrategy !== undefined) {
        payload['retryStrategy'] = body.retryStrategy;
    }
    if (body.infos !== undefined && body.infos.length > 0) {
        payload['infos'] = body.infos;
    }
    // The wrapper object. A bare array here is accepted and then ignored by the server.
    if (body.syncOptions !== undefined && body.syncOptions.length > 0) {
        payload['syncOptions'] = { items: body.syncOptions };
    }
    return JSON.stringify(payload);
}

function parseJsonBody<T>(body: string): T {
    if (body.trim() === '') {
        return {} as T;
    }
    return JSON.parse(body) as T;
}

/**
 * Encode a rollback request.
 *
 * `id` is an int64 and goes on the wire as a JSON NUMBER, not a string. Argo CD's REST
 * gateway marshals with stdlib `encoding/json` (util/grpc/json.go, wired in at
 * server/server.go), not protojson -- and the generated field is `Id *int64` with
 * `json:"id,omitempty"` and no `,string` option. Sending `"2"` therefore fails to
 * unmarshal server-side. Under protojson the opposite would be true, which is exactly how
 * this was got wrong the first time.
 *
 * The same rule applies to every int64 BODY field in this API (`expiresIn`, `iat`, `exp`).
 * Query parameters are unaffected -- a URL carries strings either way.
 */
export function encodeRollbackBody(
    name: string,
    body: { id: number; prune?: boolean; dryRun?: boolean },
    query: ResourceQuery,
): string {
    const payload: Record<string, unknown> = { name, id: body.id };
    if (query.appNamespace !== undefined && query.appNamespace !== '') {
        payload['appNamespace'] = query.appNamespace;
    }
    if (query.project !== undefined && query.project !== '') {
        payload['project'] = query.project;
    }
    if (body.prune !== undefined) {
        payload['prune'] = body.prune;
    }
    if (body.dryRun !== undefined) {
        payload['dryRun'] = body.dryRun;
    }
    return JSON.stringify(payload);
}

/** Encode a resource-action v2 request. Everything travels in the body; there are no query params. */
export function encodeRunActionBody(
    name: string,
    body: { action: string; parameters?: Array<{ name: string; value: string }>; resource: ResourceRef },
    query: ResourceQuery,
): string {
    const payload: Record<string, unknown> = {
        name,
        action: body.action,
        kind: body.resource.kind,
        resourceName: body.resource.name,
    };
    if (body.resource.group !== undefined && body.resource.group !== '') {
        payload['group'] = body.resource.group;
    }
    if (body.resource.namespace !== undefined && body.resource.namespace !== '') {
        payload['namespace'] = body.resource.namespace;
    }
    if (body.resource.version !== undefined && body.resource.version !== '') {
        payload['version'] = body.resource.version;
    }
    if (query.appNamespace !== undefined && query.appNamespace !== '') {
        payload['appNamespace'] = query.appNamespace;
    }
    if (query.project !== undefined && query.project !== '') {
        payload['project'] = query.project;
    }
    if (body.parameters !== undefined && body.parameters.length > 0) {
        payload['resourceActionParameters'] = body.parameters;
    }
    return JSON.stringify(payload);
}

/** Query parameters identifying a single resource, shared by the resource endpoints. */
export function buildResourceRefQuery(resource: ResourceRef): QueryValue[] {
    const params: QueryValue[] = [{ key: 'kind', value: resource.kind }, { key: 'resourceName', value: resource.name }];
    if (resource.group !== undefined && resource.group !== '') {
        params.push({ key: 'group', value: resource.group });
    }
    if (resource.namespace !== undefined && resource.namespace !== '') {
        params.push({ key: 'namespace', value: resource.namespace });
    }
    if (resource.version !== undefined && resource.version !== '') {
        params.push({ key: 'version', value: resource.version });
    }
    return params;
}

/**
 * Give the auto-sync rejection a real explanation.
 *
 * Argo CD refuses a rollback outright when the application has automated sync enabled,
 * because the controller would immediately sync forward again. The raw server message
 * says so but offers no way out, and this is by far the most common rollback failure.
 */
export function explainRollbackFailure(error: unknown): unknown {
    if (!(error instanceof ArgoCdApiError)) {
        return error;
    }
    if (!/auto-?sync/i.test(error.message)) {
        return error;
    }
    return new ArgoCdApiError({
        message: error.message,
        httpStatus: error.httpStatus,
        grpcCode: error.grpcCode ?? GrpcCode.FAILED_PRECONDITION,
        method: error.method,
        path: error.path,
        hint:
            'Argo CD refuses to roll back an application with automated sync enabled, because the ' +
            'controller would immediately sync it forward again. Either disable automated sync for ' +
            'the rollback, or roll back in Git and let Argo CD sync that -- the GitOps-native route, ' +
            'and the one that leaves an audit trail.',
    });
}

/** Path segment sanitiser that preserves the slashes inside a multi-segment subresource. */
function cleanPathSegment(value: string): string {
    return value.trim().replace(/^\/+|\/+$/g, '');
}

/**
 * Build the can-i path.
 *
 * Exported for testing, because the multi-segment subresource is the easy thing to break:
 * encoding it turns `payments/api` into `payments%2Fapi`, which does not match the route.
 */
export function buildCanIPath(resource: string, action: string, subresource: string): string {
    const base = `/api/v1/account/can-i/${cleanPathSegment(resource)}/${cleanPathSegment(action)}`;
    const sub = cleanPathSegment(subresource);
    return sub === '' ? base : `${base}/${sub}`;
}

/** Turn the wrapped, status-code-less apiKey failure into something a user can act on. */
export function explainAccountTokenFailure(error: unknown, account: string): unknown {
    if (!(error instanceof ArgoCdApiError)) {
        return error;
    }
    if (!/apiKey capability/i.test(error.message)) {
        return error;
    }
    return new ArgoCdApiError({
        message: error.message,
        httpStatus: error.httpStatus,
        grpcCode: error.grpcCode,
        method: error.method,
        path: error.path,
        hint:
            `The account "${account}" cannot hold API tokens. Add the apiKey capability in the ` +
            `argocd-cm ConfigMap, for example:\n  accounts.${account}: apiKey\n` +
            'This is server configuration and cannot be changed through the API.',
    });
}
