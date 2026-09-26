// Stamp one version into the extension manifest and every task.json.
//
// The Marketplace version and the version a pipeline pins with `ArgoCDApp@N` must agree,
// so a single number is written to both rather than maintained in two places. The values
// committed to git are placeholders that the release overwrites.
//
// Validate everything before writing anything: a half-stamped tree (manifest bumped, task
// not) would package cleanly and ship a version mismatch.
//
// Usage: node scripts/stamp-version.mjs 1.4.2

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const version = process.argv[2];
if (version === undefined) {
    console.error('Usage: node scripts/stamp-version.mjs <major.minor.patch>');
    process.exit(1);
}

// The Marketplace renders pre-release suffixes badly, so refuse them outright rather than
// discovering it after a publish that cannot be replaced.
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (match === null) {
    console.error(`Version must be plain major.minor.patch with no suffix, got "${version}".`);
    process.exit(1);
}
const [, major, minor, patch] = match.map(Number);

/** Everything to write, built and validated before a single file is touched. */
const pending = [];

const manifestPath = path.join(ROOT, 'vss-extension.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = version;
pending.push({ file: manifestPath, value: manifest, label: 'vss-extension.json' });

const tasksDir = path.join(ROOT, 'tasks');
for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
        continue;
    }
    const taskPath = path.join(tasksDir, entry.name, 'task.json');
    if (!fs.existsSync(taskPath)) {
        continue;
    }

    const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    const declaredMajor = task.version?.Major;

    // A task's major is its public contract: ArgoCDApp@1 is a different task from
    // ArgoCDApp@2 as far as every consumer pipeline is concerned. Refuse to change it by
    // accident -- moving it is a deliberate act that needs a new task directory.
    if (declaredMajor !== undefined && major !== declaredMajor) {
        console.error(
            `Refusing to stamp ${version} onto ${entry.name}: it declares major ${declaredMajor}. ` +
                'A major bump rewrites the TaskName@N reference in every consumer pipeline. ' +
                'Create a new versioned task directory instead.',
        );
        process.exit(1);
    }

    task.version = { Major: major, Minor: minor, Patch: patch };
    pending.push({ file: taskPath, value: task, label: `tasks/${entry.name}/task.json` });
}

for (const { file, value, label } of pending) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 4)}\n`);
    console.log(`${label} -> ${version}`);
}
