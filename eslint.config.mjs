// ESLint flat config.
//
// `tsc --noEmit` already covers types, so this exists for what types cannot catch. The rule
// that earns its place above all others is `no-floating-promises`: every task entry point is
// an async `run()` whose rejection would otherwise vanish and leave the agent reporting
// success for a step that threw.
//
// Three environments with genuinely different globals, hence three blocks:
//   * tasks/ and packages/ -- Node, no DOM
//   * tab/                 -- browser, no Node
//   * scripts/ and config  -- Node, plain .mjs/.js with no type-aware linting

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
    {
        ignores: ['dist/**', '.dev/**', 'site/**', 'node_modules/**', 'vendor/**', 'coverage/**'],
    },

    js.configs.recommended,
    // recommendedTypeChecked, NOT strict+stylistic. The stylistic sets object to Array<T>,
    // bracket access on index signatures and a dozen other choices this codebase makes
    // deliberately -- 225 findings that were all style and no bugs. What is kept below is
    // the set that finds defects.
    ...tseslint.configs.recommendedTypeChecked,

    {
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
        },
        rules: {
            // The whole reason this config exists. A dropped promise in a task means the
            // agent sees a step that returned before its work finished.
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',

            // Unused code is a review signal, not a build failure; `_`-prefixed is the
            // established escape hatch for a deliberately ignored parameter.
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
            ],

            // Argo CD responses are genuinely partially-typed, and the client narrows them
            // deliberately. Flag `any` so it stays a decision, not a default.
            '@typescript-eslint/no-explicit-any': 'warn',

            // These fight the codebase's existing, deliberate style rather than finding bugs.
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

            // Kept from the strict set: these three catch real mistakes.
            '@typescript-eslint/no-unnecessary-type-assertion': 'error',
            '@typescript-eslint/no-duplicate-type-constituents': 'error',
            '@typescript-eslint/no-meaningless-void-operator': 'error',

            // NOT enabled: no-unnecessary-condition. Argo CD responses are typed
            // optimistically from the swagger, so a guard it calls "unnecessary" is usually
            // correct defence against a field the server really can omit. Acting on it would
            // introduce crashes, not remove dead code.

            // An async function with no await is normal where a signature is dictated by an
            // interface -- every operation in tasks/ArgoCDAppV1/operations returns a promise.
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/no-empty-function': 'off',
        },
    },

    {
        files: ['packages/**/*.ts', 'tasks/**/*.ts', 'test/**/*.ts'],
        languageOptions: { globals: globals.node },
    },

    {
        files: ['tab/**/*.ts'],
        languageOptions: {
            globals: globals.browser,
            // The tab is a separate compilation unit (DOM lib, ESM). The root tsconfig does
            // not include it, so name its project explicitly or every file fails to parse.
            parserOptions: { projectService: false, project: ['./tsconfig.tab.json'] },
        },
        rules: {
            // The tab builds every node with createElement/textContent under a strict host
            // CSP. Nothing here may ever assemble markup from a string.
            'no-restricted-properties': [
                'error',
                { object: 'document', property: 'write', message: 'Not permitted under the host CSP.' },
                { property: 'innerHTML', message: 'Build nodes with createElement/textContent -- CSP and injection.' },
                { property: 'outerHTML', message: 'Build nodes with createElement/textContent -- CSP and injection.' },
            ],
        },
    },

    {
        // Tests assert on loose fixture shapes; the strict type-checked rules add noise there
        // without catching anything a failing test would not.
        files: ['**/test/**/*.ts', '**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
        },
    },

    {
        // Root config files sit outside tsconfig's `include`, so the type-aware project
        // service cannot resolve them. Lint them without type information rather than
        // widening tsconfig, which would drag build config into the shipped typecheck.
        files: ['*.config.ts', '*.config.mjs', '*.config.js'],
        ...tseslint.configs.disableTypeChecked,
        languageOptions: {
            globals: globals.node,
            // disableTypeChecked switches off type-aware RULES; the parser still tries to
            // place the file in a project and errors when it cannot. This is the other half.
            parserOptions: { projectService: false, project: null },
        },
    },

    {
        // Build scripts and config: plain JS, no type information to lint against.
        files: ['**/*.mjs', '**/*.js'],
        ...tseslint.configs.disableTypeChecked,
        languageOptions: {
            globals: { ...globals.node, ...globals.browser },
            parserOptions: { projectService: false, project: null },
        },
        rules: {
            // Spread, not replace: disableTypeChecked carries its own `rules` map, and an
            // own `rules` key here would silently re-enable every type-aware rule on files
            // that have no project to type-check against.
            ...tseslint.configs.disableTypeChecked.rules,
            // These are CommonJS build config and ESM build scripts, not shipped TypeScript.
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
);
