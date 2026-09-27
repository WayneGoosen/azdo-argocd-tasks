// Guard the Marketplace-facing parts of vss-extension.json.
//
// These are all things that cannot fail locally and cannot fail at package time -- they fail
// silently on the published listing, where the only way to fix them is to burn another
// version number, because the Marketplace never lets a version be re-uploaded.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');

interface ExtensionManifest {
    id: string;
    public?: boolean;
    icons?: Record<string, string>;
    content?: { details?: { path?: string } };
    screenshots?: Array<{ path: string }>;
    files: Array<{ path: string; addressable?: boolean }>;
}

function readManifest(file: string): ExtensionManifest {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) as ExtensionManifest;
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
