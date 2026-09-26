import { describe, expect, it } from 'vitest';
import {
    CliEndpoint,
    cliEnvironment,
    cliGlobalFlags,
    foldArguments,
    isPlaintext,
    serverAddress,
} from '../src/cli';

function endpoint(overrides: Partial<CliEndpoint> = {}): CliEndpoint {
    return { url: 'https://argocd.example.com', token: 'tok', ...overrides };
}

describe('serverAddress', () => {
    it.each([
        ['https://argocd.example.com', 'argocd.example.com'],
        ['http://argocd.example.com', 'argocd.example.com'],
        ['https://argocd.example.com/', 'argocd.example.com'],
        ['https://example.com/argocd', 'example.com/argocd'],
        ['https://example.com/argocd/', 'example.com/argocd'],
        ['https://argocd.example.com:8443', 'argocd.example.com:8443'],
    ])('strips the scheme from %s', (input, expected) => {
        // ARGOCD_SERVER is documented as the address WITHOUT the scheme.
        expect(serverAddress(input)).toBe(expected);
    });
});

describe('isPlaintext', () => {
    it('detects an http server', () => {
        expect(isPlaintext('http://argocd.internal')).toBe(true);
        expect(isPlaintext('https://argocd.internal')).toBe(false);
    });
});

describe('cliEnvironment', () => {
    it('puts the token in the environment', () => {
        const env = cliEnvironment(endpoint(), { configDir: '/tmp/cfg' });
        expect(env['ARGOCD_AUTH_TOKEN']).toBe('tok');
        expect(env['ARGOCD_SERVER']).toBe('argocd.example.com');
        expect(env['ARGOCD_CONFIG_DIR']).toBe('/tmp/cfg');
    });

    it('omits the token entirely when the connection has none', () => {
        const env = cliEnvironment(endpoint({ token: undefined }), { configDir: '/tmp/cfg' });
        expect(env).not.toHaveProperty('ARGOCD_AUTH_TOKEN');
    });

    it('never emits ARGOCD_OPTS, which would be parsed at CLI init time', () => {
        expect(cliEnvironment(endpoint(), { configDir: '/tmp/cfg' })).not.toHaveProperty('ARGOCD_OPTS');
    });
});

describe('cliGlobalFlags', () => {
    it('is empty for a plain https server', () => {
        expect(cliGlobalFlags(endpoint())).toEqual([]);
    });

    it('adds --plaintext for an http server', () => {
        expect(cliGlobalFlags(endpoint({ url: 'http://argocd.internal' }))).toContain('--plaintext');
    });

    it('adds --insecure when the connection skips verification', () => {
        expect(cliGlobalFlags(endpoint({ insecureSkipTlsVerify: true }))).toContain('--insecure');
    });

    it('passes the root path as two separate arguments', () => {
        // The historical ARGOCD_OPTS bug was about `--flag=value` parsing; separate argv
        // entries have always been the reliable form.
        const flags = cliGlobalFlags(endpoint({ rootPath: '/argocd' }));
        expect(flags).toEqual(['--grpc-web-root-path', '/argocd']);
    });

    it('points --server-crt at a CA file when one was written', () => {
        expect(cliGlobalFlags(endpoint(), { caCertPath: '/tmp/ca.pem' })).toEqual([
            '--server-crt',
            '/tmp/ca.pem',
        ]);
    });

    it('adds --grpc-web on request', () => {
        expect(cliGlobalFlags(endpoint(), { grpcWeb: true })).toContain('--grpc-web');
    });

    it('never puts the token in argv', () => {
        const flags = cliGlobalFlags(endpoint({ rootPath: '/argocd', insecureSkipTlsVerify: true }), {
            caCertPath: '/tmp/ca.pem',
            grpcWeb: true,
        });
        expect(flags.join(' ')).not.toContain('tok');
        expect(flags).not.toContain('--auth-token');
    });
});

describe('foldArguments', () => {
    it('folds newlines into one invocation', () => {
        expect(foldArguments('app sync\n  payments-api\n --prune')).toBe('app sync payments-api --prune');
    });

    it('drops blank lines', () => {
        expect(foldArguments('app list\n\n\n')).toBe('app list');
    });

    it('drops comment lines', () => {
        expect(foldArguments('# what this does\napp list')).toBe('app list');
    });

    it('keeps a hash that is not at the start of a line', () => {
        expect(foldArguments('app set x --helm-set tag=sha#1')).toBe('app set x --helm-set tag=sha#1');
    });

    it('returns an empty string for empty input', () => {
        expect(foldArguments('   \n  \n')).toBe('');
    });
});
