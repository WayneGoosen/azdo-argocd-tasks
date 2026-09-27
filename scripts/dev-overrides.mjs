// Prepare a dev build that can coexist with the production extension.
//
// WHY THIS EXISTS: service endpoint type names are a GLOBAL namespace across the whole
// Marketplace, not per-publisher and not per-extension. Two extensions may not both declare
// one called `argocdrest`, and the first publish to claim a name holds it.
//
// That bit us: publishing the dev extension claimed the name, and the production publish
// was then rejected with
//
//   The Service Endpoint Contribution Microsoft.VisualStudio.Services.ServiceEndpointName.ARGOCD
//   with Name ARGOCD already exists in the Marketplace.
//
// So the dev build gets its own endpoint name, derived from production's with a `dev`
// suffix. Derived rather than hard-coded so the two cannot drift apart.
//
// The rename has to happen in two places that must agree, or the connection picker in the
// dev extension silently offers nothing:
//   1. the endpoint contribution in the manifest       -> written to the overrides file
//   2. every `connectedService:<name>` input in a task -> patched in dist/tasks/*/task.json
//
// Usage: node scripts/dev-overrides.mjs <version> [--tasks-dir <dir>] [--out <file>]
//
// --tasks-dir and --out default to the real build output. They exist so the test can run
// this against a scratch copy: patching task.json in place is destructive, and a test that
// left dist/ carrying the dev endpoint name would hand the next `npm run package` a VSIX
// whose tasks ask for a connection type the manifest does not declare.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT_TYPE = 'ms.vss-endpoint.service-endpoint-type';

function flag(name, fallback) {
    const at = process.argv.indexOf(name);
    return at === -1 ? fallback : process.argv[at + 1];
}

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('Usage: node scripts/dev-overrides.mjs <major.minor.patch> [--tasks-dir <dir>] [--out <file>]');
    process.exit(1);
}

const tasksDir = path.resolve(ROOT, flag('--tasks-dir', path.join('dist', 'tasks')));
const outFile = path.resolve(ROOT, flag('--out', 'vss-extension.dev.effective.json'));

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

const base = readJson('vss-extension.json');
const overrides = readJson('vss-extension.dev.json');

if (overrides.public !== false) {
    throw new Error('vss-extension.dev.json must pin "public": false');
}

const endpoint = base.contributions.find((c) => c.type === ENDPOINT_TYPE);
if (!endpoint) {
    throw new Error(`No ${ENDPOINT_TYPE} contribution in vss-extension.json`);
}

const prodName = endpoint.properties.name;
const devName = `${prodName}dev`;

// tfx merges the overrides file over the manifest, and replaces arrays wholesale rather
// than merging them -- so the contributions array has to be emitted in full.
const contributions = base.contributions.map((c) =>
    c.type === ENDPOINT_TYPE
        ? { ...c, properties: { ...c.properties, name: devName, displayName: `${c.properties.displayName} (Dev)` } }
        : c,
);

const effective = { ...overrides, version, contributions };
fs.writeFileSync(outFile, `${JSON.stringify(effective, null, 4)}\n`);

// Patch the built task manifests to match. This targets build output, never the tracked
// tasks/ sources.
if (!fs.existsSync(tasksDir)) {
    throw new Error(`${path.relative(ROOT, tasksDir)} is missing -- run scripts/build.mjs first`);
}

let patched = 0;
for (const task of fs.readdirSync(tasksDir)) {
    const file = path.join(tasksDir, task, 'task.json');
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replaceAll(`"connectedService:${prodName}"`, `"connectedService:${devName}"`);
    if (after !== before) {
        fs.writeFileSync(file, after);
        patched += 1;
    }
}

console.log(`Dev build ${version}: endpoint "${prodName}" -> "${devName}", ${patched} task manifest(s) patched.`);
