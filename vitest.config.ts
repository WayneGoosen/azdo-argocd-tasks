import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/test/**/*.test.ts', 'tasks/*/test/**/*.test.ts', 'test/**/*.test.ts'],
        environment: 'node',
        // Builds dist/ once before collection. Suites that read dist/ at collection time
        // (bundle-hygiene) or spawn it (the e2e harness) cannot otherwise rely on it.
        globalSetup: ['./test/support/global-setup.ts'],
    },
});
