// Error mapping for the Argo CD grpc-gateway JSON API.
//
// Argo CD 3.x pins grpc-gateway v1.16.0 and registers no custom error handler, so error
// bodies are v1's `internal.Error`, marshalled with encoding/json:
//
//     { "error": "...", "code": 7, "message": "...", "details": [] }
//
// Because Argo CD marshals with encoding/json (not jsonpb), `omitempty` is honoured:
// EVERY field is optional, and `code` is absent whenever the gRPC code is 0. So parsing
// must not assume any field is present, and `error` is preferred over `message` (they
// carry the same string when both appear).

/** gRPC status codes, as they appear in the `code` field of an error body. */
export const GrpcCode = {
    OK: 0,
    CANCELLED: 1,
    UNKNOWN: 2,
    INVALID_ARGUMENT: 3,
    DEADLINE_EXCEEDED: 4,
    NOT_FOUND: 5,
    ALREADY_EXISTS: 6,
    PERMISSION_DENIED: 7,
    RESOURCE_EXHAUSTED: 8,
    FAILED_PRECONDITION: 9,
    ABORTED: 10,
    OUT_OF_RANGE: 11,
    UNIMPLEMENTED: 12,
    INTERNAL: 13,
    UNAVAILABLE: 14,
    DATA_LOSS: 15,
    UNAUTHENTICATED: 16,
} as const;

export interface ArgoCdErrorBody {
    error?: string;
    code?: number;
    message?: string;
    details?: unknown[];
}

export class ArgoCdApiError extends Error {
    public readonly httpStatus: number;
    public readonly grpcCode: number | undefined;
    public readonly method: string;
    public readonly path: string;
    /** Actionable remediation, when the failure has a known cause. */
    public readonly hint: string | undefined;

    public constructor(init: {
        message: string;
        httpStatus: number;
        grpcCode?: number | undefined;
        method: string;
        path: string;
        hint?: string | undefined;
    }) {
        super(init.hint === undefined ? init.message : `${init.message}\n\n${init.hint}`);
        this.name = 'ArgoCdApiError';
        this.httpStatus = init.httpStatus;
        this.grpcCode = init.grpcCode;
        this.method = init.method;
        this.path = init.path;
        this.hint = init.hint;
    }

    public get isNotFound(): boolean {
        return this.httpStatus === 404 || this.grpcCode === GrpcCode.NOT_FOUND;
    }

    public get isPermissionDenied(): boolean {
        return this.httpStatus === 403 || this.grpcCode === GrpcCode.PERMISSION_DENIED;
    }

    public get isUnauthenticated(): boolean {
        return this.httpStatus === 401 || this.grpcCode === GrpcCode.UNAUTHENTICATED;
    }
}

export function parseErrorBody(body: string): ArgoCdErrorBody {
    if (body.trim() === '') {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed !== 'object' || parsed === null) {
            return {};
        }
        const candidate = parsed as Record<string, unknown>;
        const result: ArgoCdErrorBody = {};
        if (typeof candidate['error'] === 'string') {
            result.error = candidate['error'];
        }
        if (typeof candidate['message'] === 'string') {
            result.message = candidate['message'];
        }
        if (typeof candidate['code'] === 'number') {
            result.code = candidate['code'];
        }
        if (Array.isArray(candidate['details'])) {
            result.details = candidate['details'];
        }
        return result;
    } catch {
        return {};
    }
}

/**
 * Build an ArgoCdApiError from a non-2xx response.
 *
 * `projectSupplied` drives the single most confusing failure mode in this API. Argo CD
 * deliberately refuses to distinguish "app does not exist" from "you may not see it"
 * when no project is given -- getAppEnforceRBAC returns `permission denied` for both,
 * and even performs a dummy lookup so response timing cannot leak existence either.
 * Supplying `project` turns the missing-app case into a real 404, so when we see a bare
 * 403 without a project we say so rather than letting the user guess.
 */
export function errorFromResponse(args: {
    status: number;
    body: string;
    method: string;
    path: string;
    projectSupplied: boolean;
}): ArgoCdApiError {
    const parsed = parseErrorBody(args.body);
    const message =
        parsed.error ?? parsed.message ?? `Argo CD returned HTTP ${args.status} with no error message`;

    let hint: string | undefined;
    if (args.status === 403 && !args.projectSupplied) {
        hint =
            'Argo CD returns "permission denied" both when an application does not exist and when ' +
            'your token may not see it. Set the "project" input so the API can return a real 404 ' +
            'for a missing application, which distinguishes a typo from an RBAC problem.';
    } else if (args.status === 403) {
        hint =
            'The token is valid but not authorised for this application. Check the Argo CD RBAC ' +
            'policy grants this account "applications, get" (and "sync" for syncing) on the project.';
    } else if (args.status === 401) {
        hint =
            'The Argo CD token was rejected. Project role tokens and account API tokens expire -- ' +
            'check the token in the service connection has not passed its expiry.';
    } else if (args.status === 404) {
        hint = 'Check the application name, and that "appNamespace" matches where the Application lives.';
    }

    return new ArgoCdApiError({
        message,
        httpStatus: args.status,
        grpcCode: parsed.code,
        method: args.method,
        path: args.path,
        hint,
    });
}
