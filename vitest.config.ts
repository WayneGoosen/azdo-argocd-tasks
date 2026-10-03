import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/test/**/*.test.ts', 'tasks/*/test/**/*.test.ts', 'test/**/*.test.ts', 'tab/test/**/*.test.ts'],
        environment: 'node',
        // Builds dist/ once before collection. Suites that read dist/ at collection time
        // (bundle-hygiene) or spawn it (the e2e harness) cannot otherwise rely on it.
        globalSetup: ['./test/support/global-setup.ts'],
        coverage: {
            provider: 'v8',
            // lcov for Sonar, text for a local eyeball, json-summary for a quick read in CI.
            reporter: ['text', 'lcov', 'json-summary'],
            reportsDirectory: './coverage',
            include: ['packages/*/src/**/*.ts', 'tasks/**/*.ts', 'tab/*.ts'],
            exclude: [
                // Entry points are exercised end-to-end through the bundled artifacts, not
                // by importing them, so line coverage here measures nothing useful.
                '**/index.ts',
                '**/*.d.ts',
            ],
        },
    },
});
