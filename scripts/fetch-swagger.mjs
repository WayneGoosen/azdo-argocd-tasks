// Vendor the Argo CD OpenAPI spec used by the contract test.
//
// Pinned to the OLDEST SUPPORTED MINOR on purpose: Argo CD supports only the three most
// recent minors, and anything present in the oldest is present in the newer ones. A
// contract that passes here works across the whole supported range.
//
// The spec's own info.version is literally "version not set", so the git tag is the only
// reliable version marker -- hence writing a sidecar file recording which tag we pinned.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'vendor', 'swagger');

const TAG = process.argv[2] ?? 'v3.3.14';
const URL = `https://raw.githubusercontent.com/argoproj/argo-cd/${TAG}/assets/swagger.json`;

const response = await fetch(URL);
if (!response.ok) {
    console.error(`Failed to fetch ${URL}: HTTP ${response.status}`);
    process.exit(1);
}

const spec = await response.json();
fs.mkdirSync(OUT_DIR, { recursive: true });

const specFile = path.join(OUT_DIR, 'argocd.json');
fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
fs.writeFileSync(
    path.join(OUT_DIR, 'VERSION'),
    `${TAG}\n${URL}\npaths=${Object.keys(spec.paths ?? {}).length}\ndefinitions=${Object.keys(spec.definitions ?? {}).length}\n`,
);

console.log(`Vendored ${TAG}: ${Object.keys(spec.paths ?? {}).length} paths, ${Object.keys(spec.definitions ?? {}).length} definitions`);
