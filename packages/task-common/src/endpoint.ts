// Reading the Argo CD service connection.
//
// The token is masked the instant it is read, before anything can log it. Everything
// downstream (including error messages from the client) is therefore safe to print.

import * as tl from 'azure-pipelines-task-lib/task';
import { registerSecret } from './secrets';

export interface ArgoCdEndpoint {
    url: string;
    token: string | undefined;
    insecureSkipTlsVerify: boolean;
    caCertificate: string | undefined;
    /** Sub-path the Argo CD server is served under, e.g. "/argocd". */
    rootPath: string | undefined;
}

const AUTH_SCHEME_TOKEN = 'token';
const AUTH_SCHEME_NONE = 'none';

export function readArgoCdEndpoint(inputName: string): ArgoCdEndpoint {
    const connectionId = tl.getInput(inputName, true);
    if (connectionId === undefined || connectionId === '') {
        throw new Error(`No Argo CD service connection was supplied in "${inputName}".`);
    }

    const url = tl.getEndpointUrl(connectionId, false);
    if (url === undefined || url.trim() === '') {
        throw new Error('The Argo CD service connection has no server URL.');
    }

    const scheme = (tl.getEndpointAuthorizationScheme(connectionId, true) ?? AUTH_SCHEME_TOKEN).toLowerCase();

    let token: string | undefined;
    if (scheme === AUTH_SCHEME_TOKEN) {
        token = tl.getEndpointAuthorizationParameter(connectionId, 'apitoken', false);
        if (token === undefined || token === '') {
            throw new Error(
                'The Argo CD service connection uses token authentication but carries no token. ' +
                    'Add an Argo CD project role token or account API token to the service connection.',
            );
        }
        // Mask first, use second. Everything after this point may be logged freely.
        // registerSecret also records it, so anything we write to a file and publish can be
        // checked against it -- tl.setSecret alone only masks the agent's log stream.
        registerSecret(token);
    } else if (scheme !== AUTH_SCHEME_NONE) {
        throw new Error(
            `Unsupported authentication scheme "${scheme}" on the Argo CD service connection. ` +
                'Use token authentication, or "none" when the task obtains credentials itself.',
        );
    }

    const insecureSkipTlsVerify = readBooleanDataParameter(connectionId, 'insecureSkipTlsVerify');
    if (insecureSkipTlsVerify) {
        tl.warning(
            'TLS certificate verification is disabled on this Argo CD service connection. ' +
                'Traffic is encrypted but the server identity is not verified. Prefer supplying a custom CA.',
        );
    }

    return {
        url: url.trim(),
        token,
        insecureSkipTlsVerify,
        caCertificate: emptyToUndefined(tl.getEndpointDataParameter(connectionId, 'caCertificate', true)),
        rootPath: emptyToUndefined(tl.getEndpointDataParameter(connectionId, 'grpcWebRootPath', true)),
    };
}

function readBooleanDataParameter(connectionId: string, key: string): boolean {
    const raw = tl.getEndpointDataParameter(connectionId, key, true);
    return raw !== undefined && raw.toLowerCase() === 'true';
}

function emptyToUndefined(value: string | undefined): string | undefined {
    return value === undefined || value.trim() === '' ? undefined : value;
}
