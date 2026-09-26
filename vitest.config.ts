import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/test/**/*.test.ts', 'tasks/*/test/**/*.test.ts', 'test/**/*.test.ts'],
        environment: 'node',
    },
});
