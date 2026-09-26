// Cross-check every task.json against the code that reads it.
//
// task.json is hand-written on purpose: it defines the public UI, and generating it from a
// schema (as the PRD suggests) buys less than the indirection costs. The real risk in
// hand-writing it is DRIFT -- an input renamed in code but not in the manifest reads as
// empty on the agent and silently takes its default, which is exactly the kind of bug that
// ships. This test closes that gap without codegen.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const TASKS_DIR = path.join(ROOT, 'tasks');

/** Inputs a task can legitimately read without declaring, because the agent injects them. */
const IMPLICIT_INPUTS = new Set<string>([]);

/** Declared inputs that are deliberately not read by name, if any. */
const DECLARED_BUT_UNREAD = new Set<string>([]);

interface TaskManifest {
    name: string;
    inputs: Array<{ name: string; groupName?: string; visibleRule?: string }>;
    groups?: Array<{ name: string }>;
    outputVariables?: Array<{ name: string }>;
    restrictions?: { settableVariables?: { allowed?: string[] } };
}

function taskDirectories(): string[] {
    return fs
        .readdirSync(TASKS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => fs.existsSync(path.join(TASKS_DIR, entry.name, 'task.json')))
        .map((entry) => entry.name);
}

function sourceFiles(directory: string): string[] {
    const results: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.ts')) {
                results.push(full);
            }
        }
    };
    walk(directory);
    return results;
}

/**
 * Input names referenced by any input accessor.
 *
 * This deliberately includes the repo's own wrappers (`readArgoCdEndpoint`, `requiredInput`,
 * `getRefreshType`, `getBoolInputOrDefault`, `getPositiveInt`) as well as task-lib's. They
 * all take the input name as their first argument, so treating them the same keeps the
 * check honest without forcing every call through `tl.getInput` directly.
 */
function readInputNames(files: readonly string[]): Set<string> {
    const pattern =
        /\b(?:tl\.)?(?:getInput|getBoolInput|getPathInput|getDelimitedInput|getInputRequired|getBoolInputOrDefault|getPositiveInt|getRefreshType|readArgoCdEndpoint|requiredInput)\(\s*'([^']+)'/g;
    const names = new Set<string>();
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(pattern)) {
            names.add(match[1] as string);
        }
    }
    return names;
}

describe.each(taskDirectories())('%s task.json', (taskName) => {
    const taskDir = path.join(TASKS_DIR, taskName);
    const manifest = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8')) as TaskManifest;
    const declared = new Set(manifest.inputs.map((input) => input.name));
    const read = readInputNames(sourceFiles(taskDir));

    it('declares every input the code reads', () => {
        const missing = [...read].filter((name) => !declared.has(name) && !IMPLICIT_INPUTS.has(name));
        expect(missing, `read in code but not declared in task.json: ${missing.join(', ')}`).toEqual([]);
    });

    it('reads every input it declares', () => {
        const unused = [...declared].filter((name) => !read.has(name) && !DECLARED_BUT_UNREAD.has(name));
        expect(unused, `declared in task.json but never read: ${unused.join(', ')}`).toEqual([]);
    });

    it('references only groups it defines', () => {
        const groups = new Set((manifest.groups ?? []).map((group) => group.name));
        const dangling = manifest.inputs
            .map((input) => input.groupName)
            .filter((group): group is string => group !== undefined && !groups.has(group));
        expect(dangling).toEqual([]);
    });

    it('allows every output variable it sets', () => {
        // settableVariables is a hard gate on the agent: an output missing from the
        // allowlist is silently dropped rather than erroring.
        const allowed = new Set(manifest.restrictions?.settableVariables?.allowed ?? []);
        if (allowed.size === 0) {
            return;
        }
        const outputs = (manifest.outputVariables ?? []).map((output) => output.name);
        const blocked = outputs.filter((name) => !allowed.has(name));
        expect(blocked, `declared as output but not in settableVariables: ${blocked.join(', ')}`).toEqual([]);
    });
});
