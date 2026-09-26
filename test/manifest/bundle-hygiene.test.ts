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

function builtTasks(): string[] {
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

describe('bundle hygiene', () => {
    beforeAll(() => {
        ensureBuilt();
    });

    it.each(builtTasks())('%s stays under the size budget', (task) => {
        const kib = fs.statSync(path.join(DIST_TASKS, task, 'index.js')).size / 1024;
        expect(kib, `${task} is ${kib.toFixed(0)} KiB`).toBeLessThan(MAX_BUNDLE_KIB);
    });

    it.each(builtTasks())('%s bundles no heavy dependency it cannot justify', (task) => {
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
