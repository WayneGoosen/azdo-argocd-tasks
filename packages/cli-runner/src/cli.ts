import { trimSlashes } from '@azdo-argocd/argocd-client';
// Building the environment and argv for an `argocd` invocation.
//
// The security-relevant decision lives here: the token goes into the child process
// ENVIRONMENT and nowhere else. Microsoft is explicit that secrets must never be passed on
// a command line, because some operating systems log argv. The prior-art Argo CD installer
// extension instead exports ARGOCD_AUTH_TOKEN as an ordinary pipeline variable, which makes
// it readable by every later step in the job; that is precisely what this avoids.
//
// Global flags go in argv rather than ARGOCD_OPTS. ARGOCD_OPTS is parsed at CLI init() time
// by a shell-quote splitter, and a value it cannot parse causes a log.Fatal before the
// command runs at all -- an unhelpful failure mode to expose to a pipeline author.

/**
 * The endpoint fields this module needs.
 *
 * Declared structurally rather than imported from task-common, because that module imports
 * azure-pipelines-task-lib, whose module-level initialisation runs on load. Keeping the
 * dependency structural means these functions stay pure and their tests need no agent.
 * task-common's ArgoCdEndpoint satisfies this shape.
 */
export interface CliEndpoint {
    url: string;
    token?: string | undefined;
    insecureSkipTlsVerify?: boolean | undefined;
    rootPath?: string | undefined;
}

export interface CliEnvironmentOptions {
    /** Per-step config directory, so runs cannot see each other's session state. */
    configDir: string;
}

/**
 * ARGOCD_SERVER wants the address WITHOUT the scheme, e.g. "argocd.example.com" or
 * "example.com/argocd" for a sub-path install.
 */
export function serverAddress(serverUrl: string): string {
    // The scheme regex is anchored at the start and linear; only the trailing-slash strip
    // was the polynomial one.
    return trimSlashes(serverUrl.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''));
}

export function isPlaintext(serverUrl: string): boolean {
    return /^http:\/\//i.test(serverUrl.trim());
}

export function cliEnvironment(
    endpoint: CliEndpoint,
    options: CliEnvironmentOptions,
): Record<string, string> {
    const env: Record<string, string> = {
        ARGOCD_SERVER: serverAddress(endpoint.url),
        ARGOCD_CONFIG_DIR: options.configDir,
    };
    if (endpoint.token !== undefined && endpoint.token !== '') {
        env['ARGOCD_AUTH_TOKEN'] = endpoint.token;
    }
    return env;
}

export interface GlobalFlagOptions {
    /** Path to a temporary PEM file holding the connection's custom CA, when there is one. */
    caCertPath?: string | undefined;
    grpcWeb?: boolean;
}

export function cliGlobalFlags(endpoint: CliEndpoint, options: GlobalFlagOptions = {}): string[] {
    const flags: string[] = [];

    if (isPlaintext(endpoint.url)) {
        flags.push('--plaintext');
    }
    if (endpoint.insecureSkipTlsVerify) {
        flags.push('--insecure');
    }
    if (options.caCertPath !== undefined && options.caCertPath !== '') {
        flags.push('--server-crt', options.caCertPath);
    }
    if (options.grpcWeb === true) {
        flags.push('--grpc-web');
    }
    if (endpoint.rootPath !== undefined && endpoint.rootPath !== '') {
        // Pass as separate argv entries. The historical bug where this was dropped inside
        // ARGOCD_OPTS (argoproj/argo-cd#6822) was a `--flag=value` parsing problem; passing
        // flag and value as distinct arguments has always been the reliable form.
        flags.push('--grpc-web-root-path', endpoint.rootPath);
    }
    return flags;
}

/**
 * Fold the multiline `arguments` input into one argument string.
 *
 * Newlines exist for readability; this is a single `argocd` invocation, which is what keeps
 * the exit-code output unambiguous. A line whose first non-space character is `#` is a
 * comment.
 */
export function foldArguments(raw: string): string {
    return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .join(' ')
        .trim();
}
