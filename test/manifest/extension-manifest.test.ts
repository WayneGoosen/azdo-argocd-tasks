// Guard the Marketplace-facing parts of vss-extension.json.
//
// These are all things that cannot fail locally and cannot fail at package time -- they fail
// silently on the published listing, where the only way to fix them is to burn another
// version number, because the Marketplace never lets a version be re-uploaded.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';

const ROOT = path.join(__dirname, '..', '..');

interface EndpointContribution {
    type: string;
    properties: { name: string; displayName: string };
}

interface TaskManifest {
    name: string;
    inputs: Array<{ name: string; type: string }>;
}

interface Contribution {
    id: string;
    type: string;
    properties?: Record<string, unknown>;
}

interface ExtensionManifest {
    id: string;
    scopes?: string[];
    contributions?: EndpointContribution[];
    public?: boolean;
    icons?: Record<string, string>;
    content?: { details?: { path?: string } };
    screenshots?: Array<{ path: string }>;
    files: Array<{ path: string; addressable?: boolean }>;
}

function readManifest(file: string): ExtensionManifest {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as ExtensionManifest;
}

const ENDPOINT_TYPE = 'ms.vss-endpoint.service-endpoint-type';

function endpointContribution(m: ExtensionManifest): EndpointContribution {
    const found = (m.contributions ?? []).find((c) => c.type === ENDPOINT_TYPE);
    if (!found) throw new Error('no service-endpoint-type contribution');
    return found;
}

function taskManifests(): TaskManifest[] {
    const dir = path.join(ROOT, 'tasks');
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'task.json')))
        .map((e) => JSON.parse(fs.readFileSync(path.join(dir, e.name, 'task.json'), 'utf8')) as TaskManifest);
}

const manifest = readManifest('vss-extension.json');
const devOverrides = readManifest('vss-extension.dev.json');

describe('extension manifest', () => {
    it('keeps the dev build private even though the production one is public', () => {
        // The dev workflow publishes vss-extension.json with these overrides layered on top.
        // If this line is ever dropped, the dev build inherits public:true and a build whose
        // own description says "not for production use" lands on the public Marketplace.
        expect(devOverrides.public, 'dev overrides must pin public:false').toBe(false);
        expect(devOverrides.id).not.toBe(manifest.id);
    });

    it('points every asset path at a file that exists', () => {
        const assets = [
            manifest.icons?.default,
            manifest.content?.details?.path,
            ...(manifest.screenshots ?? []).map((s) => s.path),
        ].filter((p): p is string => typeof p === 'string');

        expect(assets.length, 'expected at least an icon and an overview').toBeGreaterThan(1);
        for (const asset of assets) {
            expect(fs.existsSync(path.join(ROOT, asset)), `${asset} is declared but missing`).toBe(true);
        }
    });

    it('declares the same endpoint type name that every task asks for', () => {
        // A `connectedService:<name>` input whose name does not match the endpoint
        // contribution is not an error anywhere -- the connection picker just comes up
        // empty, and the task is unusable with no clue why.
        const endpoint = endpointContribution(manifest);
        for (const task of taskManifests()) {
            const connections = task.inputs
                .filter((i) => i.type.startsWith('connectedService:'))
                .map((i) => i.type.slice('connectedService:'.length));
            for (const name of connections) {
                expect(name, `${task.name} asks for an endpoint type nothing declares`).toBe(
                    endpoint.properties.name,
                );
            }
        }
    });

    it('gives the dev build a different endpoint type name', () => {
        // Service endpoint type names are a Marketplace-GLOBAL namespace: one extension
        // holding a name blocks every other extension that declares it, including our own.
        // A dev build sharing production's name makes the production publish impossible --
        // this is exactly how the 1.0.4 publish was rejected.
        // Run against a scratch copy of the task manifests: the script patches them in
        // place, and poisoning dist/ here would ship a VSIX whose tasks ask for a
        // connection type the manifest does not declare.
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'argocd-dev-overrides-'));
        const scratchTasks = path.join(scratch, 'tasks');
        const outFile = path.join(scratch, 'effective.json');
        for (const task of taskManifests()) {
            fs.mkdirSync(path.join(scratchTasks, task.name), { recursive: true });
            fs.writeFileSync(
                path.join(scratchTasks, task.name, 'task.json'),
                JSON.stringify(task, null, 4),
            );
        }

        execFileSync(
            'node',
            [
                path.join(ROOT, 'scripts', 'dev-overrides.mjs'),
                '9.9.9',
                '--tasks-dir', scratchTasks,
                '--out', outFile,
            ],
            { cwd: ROOT, encoding: 'utf8' },
        );

        const effective = JSON.parse(fs.readFileSync(outFile, 'utf8')) as ExtensionManifest;
        const devName = endpointContribution(effective).properties.name;
        expect(devName).not.toBe(endpointContribution(manifest).properties.name);

        // The manifest rename is only half of it -- the task inputs must follow, or the
        // dev extension's connection picker silently offers nothing.
        for (const task of taskManifests()) {
            const patched = JSON.parse(
                fs.readFileSync(path.join(scratchTasks, task.name, 'task.json'), 'utf8'),
            ) as TaskManifest;
            for (const input of patched.inputs.filter((i) => i.type.startsWith('connectedService:'))) {
                expect(input.type).toBe(`connectedService:${devName}`);
            }
        }

        fs.rmSync(scratch, { recursive: true, force: true });
    });

    it('keeps the tab contribution pointing at a file that is actually published', () => {
        // Two independent ways this silently yields a blank tab:
        //   * the uri must be the repo-relative path, including dist/ -- tfx does not rewrite it
        //   * dist/tab must be addressable, or it ships inside the VSIX with no URL and the
        //     iframe 404s
        const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'vss-extension.json'), 'utf8')) as {
            contributions: Contribution[];
            files: Array<{ path: string; addressable?: boolean }>;
        };
        const tab = raw.contributions.find((c) => c.type === 'ms.vss-build-web.build-results-tab');
        expect(tab, 'no build-results-tab contribution').toBeDefined();

        const uri = tab?.properties?.['uri'] as string;
        expect(fs.existsSync(path.join(ROOT, uri.replace('dist/tab/', 'tab/'))), `${uri} has no source`).toBe(true);

        const folder = raw.files.find((f) => f.path === 'dist/tab');
        expect(folder, 'dist/tab is not in files[]').toBeDefined();
        expect(folder?.addressable, 'dist/tab must be addressable or the iframe 404s').toBe(true);
    });

    it('lists only real task GUIDs in supportsTasks', () => {
        // The tab appears only on builds that ran one of these GUIDs. If one drifts from the
        // task.json it came from, the tab silently stops showing up -- no error anywhere.
        const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'vss-extension.json'), 'utf8')) as {
            contributions: Contribution[];
        };
        const tab = raw.contributions.find((c) => c.type === 'ms.vss-build-web.build-results-tab');
        const declared = (tab?.properties?.['supportsTasks'] ?? []) as string[];
        expect(declared.length).toBeGreaterThan(0);

        const real = new Set(taskManifests().map((t) => (t as unknown as { id: string }).id));
        for (const guid of declared) {
            expect(real.has(guid), `${guid} in supportsTasks matches no task.json id`).toBe(true);
        }
        expect(new Set(declared).size, 'duplicate GUID in supportsTasks').toBe(declared.length);
    });

    it('declares the build scope the tab needs', () => {
        // BuildRestClient.getAttachments needs vso.build. Note for releases: ADDING a scope
        // makes every existing install require re-authorisation by an org admin.
        expect(manifest.scopes ?? []).toContain('vso.build');
    });

    it('does not list marketplace/ in files[]', () => {
        // tfx adds assets referenced by content.details.path and screenshots[].path itself.
        // Listing the folder in files[] as well makes it add them twice, and it resolves the
        // clash by dropping the Content.Details and Screenshots.N entries -- the listing then
        // renders with no description and no images, and nothing anywhere reports an error.
        const listed = manifest.files.map((f) => f.path.replace(/\/+$/, ''));
        expect(listed).not.toContain('marketplace');
    });

    it('uses absolute image URLs in the overview', () => {
        // Relative paths resolve against the Marketplace's own host, not the VSIX, so an
        // image referenced as ./images/foo.png is simply broken on the listing page.
        const overview = fs.readFileSync(path.join(ROOT, manifest.content!.details!.path!), 'utf8');
        const relative = [...overview.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
            .map((m) => m[1] ?? '')
            .filter((url) => !/^https?:\/\//.test(url));
        expect(relative, 'overview images must use absolute https URLs').toEqual([]);
    });

    it('declares a task contribution for every built task', () => {
        const tasks = fs
            .readdirSync(path.join(ROOT, 'tasks'), { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort();
        const packaged = manifest.files
            .map((f) => f.path)
            .filter((p) => p.startsWith('dist/tasks/'))
            .map((p) => path.basename(p))
            .sort();
        expect(packaged).toEqual(tasks);
    });
});
