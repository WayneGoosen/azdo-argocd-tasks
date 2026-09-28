// Guards against bundles quietly accumulating things they do not use.
//
// This exists because of a real regression: adding a YAML-parsing module to task-common's
// barrel export pulled js-yaml into every task that imported ANYTHING from task-common --
// including four that never parse a manifest, costing ~100 KiB each. Marking the workspace
// packages `sideEffects: false` let esbuild tree-shake it away again.
//
// The dependency check is self-maintaining: a task may only carry a YAML parser if its
// task.json actually declares a manifest file input.

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureBuilt } from '../support/run-task';

const ROOT = path.join(__dirname, '..', '..');
const DIST_TASKS = path.join(ROOT, 'dist', 'tasks');

/** Generous enough not to nag, tight enough to catch a barrel leak doubling a bundle. */
const MAX_BUNDLE_KIB = 800;

interface HeavyDependency {
    name: string;
    /** A string that only appears when the dependency is really bundled. */
    marker: RegExp;
    /** A task may bundle it only if task.json declares one of these inputs. */
    justifiedBy: string[];
}

const HEAVY_DEPENDENCIES: HeavyDependency[] = [
    { name: 'js-yaml', marker: /YAMLException/, justifiedBy: ['manifestFile'] },
];

/**
 * The bundles to check, read at COLLECTION time to generate one case per task.
 *
 * globalSetup guarantees dist/ is built before this runs. It is still written to tolerate a
 * missing directory rather than throwing, because a throw here takes the whole file out of
 * the run -- and the `finds bundles to check` test below turns an empty result into a loud
 * failure instead of a file that silently contributes zero tests and passes.
 */
function builtTasks(): string[] {
    if (!fs.existsSync(DIST_TASKS)) {
        return [];
    }
    return fs.readdirSync(DIST_TASKS).filter((entry) => fs.existsSync(path.join(DIST_TASKS, entry, 'index.js')));
}

function bundleOf(task: string): string {
    return fs.readFileSync(path.join(DIST_TASKS, task, 'index.js'), 'utf8');
}

function declaredInputs(task: string): Set<string> {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'tasks', task, 'task.json'), 'utf8'),
    ) as { inputs: Array<{ name: string }> };
    return new Set(manifest.inputs.map((input) => input.name));
}

/** Captured at collection time -- see `generated a case for every task`. */
const BUILT = builtTasks();

describe('bundle hygiene', () => {
    beforeAll(() => {
        ensureBuilt();
    });

    it('generated a case for every task', () => {
        // Every other case here is generated from BUILT, which is captured at COLLECTION
        // time. If dist/ was incomplete then, those cases silently do not exist and the file
        // passes having verified nothing -- which is exactly how this suite dropped out of
        // CI runs unnoticed.
        //
        // This must assert on BUILT, not on a fresh builtTasks(): beforeAll repairs dist/
        // before any test body runs, so a re-read would look healthy while the generated
        // cases were already lost.
        const tasks = fs.readdirSync(path.join(ROOT, 'tasks'), { withFileTypes: true }).filter((e) => e.isDirectory());
        expect(BUILT, 'dist/ was incomplete when this file was collected').toHaveLength(tasks.length);
    });

    it.each(BUILT)('%s stays under the size budget', (task) => {
        const kib = fs.statSync(path.join(DIST_TASKS, task, 'index.js')).size / 1024;
        expect(kib, `${task} is ${kib.toFixed(0)} KiB`).toBeLessThan(MAX_BUNDLE_KIB);
    });

    it.each(BUILT)('%s bundles no heavy dependency it cannot justify', (task) => {
        const source = bundleOf(task);
        const inputs = declaredInputs(task);

        for (const dependency of HEAVY_DEPENDENCIES) {
            const bundled = dependency.marker.test(source);
            const justified = dependency.justifiedBy.some((input) => inputs.has(input));
            if (bundled && !justified) {
                throw new Error(
                    `${task} bundles ${dependency.name} but declares none of ` +
                        `${dependency.justifiedBy.join(', ')} -- it is almost certainly arriving through a ` +
                        'barrel re-export. Check that the workspace packages are marked sideEffects: false.',
                );
            }
        }
        expect(true).toBe(true);
    });
});
