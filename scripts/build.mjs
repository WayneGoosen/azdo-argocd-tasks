// Bundle each pipeline task into a single file with esbuild.
//
// Why bundle at all: the alternative is vendoring node_modules into the VSIX per task.
// Microsoft measured per-task download-and-extract dropping from ~4.5s to ~0.25s when
// bundling, and with several tasks in one extension the vendored tree is mostly duplicate
// copies of the same library.
//
// Three traps this handles explicitly, all documented upstream:
//
//  1. TWO COPIES OF azure-pipelines-task-lib. Its internal.js holds module-level state
//     (output streams, resource strings, variable map). If the shared package and the
//     task each resolve their own copy, that state silently splits. npm workspace
//     hoisting usually dedupes for us; the alias below makes it guaranteed rather than
//     incidental, because the failure mode is invisible at build time.
//  2. shelljs is require()d at runtime by task-lib, which esbuild cannot resolve
//     statically. It only appears in mock-task.js / mock-test.js -- test helpers that are
//     never imported by a task -- so marking them external keeps them out of the bundle
//     instead of shimming a dependency we do not use.
//  3. Bundling flattens the directory tree, so anything reading a file relative to
//     __dirname breaks. No task code may do that; task.json is read by the agent, not us.
//
// Source maps are OFF by default. The agent runs `node index.js` with no
// --enable-source-maps, so a shipped .map is never consulted at runtime -- it would just
// add ~750 KiB per task to the VSIX. Pass --sourcemap when debugging locally.

import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASKS_DIR = path.join(ROOT, 'tasks');
const OUT_DIR = path.join(ROOT, 'dist', 'tasks');

const CANONICAL_TASK_LIB = path.join(ROOT, 'node_modules', 'azure-pipelines-task-lib');

const WITH_SOURCEMAP = process.argv.includes('--sourcemap');

/** Force every import of task-lib onto one physical copy. See trap 1 above. */
const dedupeTaskLibPlugin = {
    name: 'dedupe-azure-pipelines-task-lib',
    setup(build) {
        build.onResolve({ filter: /^azure-pipelines-task-lib(\/.*)?$/ }, (args) => {
            const subpath = args.path.replace(/^azure-pipelines-task-lib\/?/, '');
            const target = subpath === '' ? path.join(CANONICAL_TASK_LIB, 'task.js') : path.join(CANONICAL_TASK_LIB, `${subpath}.js`);
            if (!fs.existsSync(target)) {
                throw new Error(`Cannot resolve "${args.path}" to a file under ${CANONICAL_TASK_LIB}`);
            }
            return { path: target };
        });
    },
};

function discoverTasks() {
    if (!fs.existsSync(TASKS_DIR)) {
        return [];
    }
    return fs
        .readdirSync(TASKS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => fs.existsSync(path.join(TASKS_DIR, entry.name, 'task.json')))
        .map((entry) => entry.name);
}

async function buildTask(taskName) {
    const sourceDir = path.join(TASKS_DIR, taskName);
    const outputDir = path.join(OUT_DIR, taskName);
    fs.mkdirSync(outputDir, { recursive: true });

    await esbuild.build({
        entryPoints: [path.join(sourceDir, 'index.ts')],
        outfile: path.join(outputDir, 'index.js'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        // The lower of the two declared handlers, so one bundle serves Node20_1 and Node24.
        target: 'node20',
        treeShaking: true,
        sourcemap: WITH_SOURCEMAP,
        logLevel: 'warning',
        external: ['azure-pipelines-task-lib/mock-task', 'azure-pipelines-task-lib/mock-test'],
        plugins: [dedupeTaskLibPlugin],
    });

    for (const asset of ['task.json', 'icon.png']) {
        const from = path.join(sourceDir, asset);
        if (fs.existsSync(from)) {
            fs.copyFileSync(from, path.join(outputDir, asset));
        } else if (asset === 'task.json') {
            throw new Error(`${taskName} has no task.json`);
        } else {
            console.warn(`  warning: ${taskName} has no ${asset}`);
        }
    }

    const bytes = fs.statSync(path.join(outputDir, 'index.js')).size;
    console.log(`  ${taskName}: ${(bytes / 1024).toFixed(1)} KiB`);
}

const tasks = discoverTasks();
if (tasks.length === 0) {
    console.error('No tasks found under tasks/');
    process.exit(1);
}

console.log(`Bundling ${tasks.length} task(s)${WITH_SOURCEMAP ? ' with source maps' : ''}:`);
for (const task of tasks) {
    await buildTask(task);
}
console.log('Build complete.');
