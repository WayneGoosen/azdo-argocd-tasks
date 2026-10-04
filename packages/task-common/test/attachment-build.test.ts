// Converting Argo CD shapes into the tab's wire contract.
//
// These matter because the tab renders whatever lands here and has no way to sanity-check
// it: a resource silently dropped, or a diff computed differently from the Markdown summary,
// shows up as a confidently wrong tab rather than an error.

import { describe, expect, it } from 'vitest';
import { toAttachmentDiffs, toAttachmentHistory, toAttachmentResources } from '../src/attachment-build';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('toAttachmentDiffs', () => {
    it('includes only modified resources', () => {
        // The managed-resources endpoint returns EVERY managed resource. Shipping the
        // unchanged ones would bloat the attachment with empty patches.
        const diffs = toAttachmentDiffs([
            { kind: 'ConfigMap', name: 'a', modified: true, liveState: '{"x":1}', targetState: '{"x":2}' },
            { kind: 'ConfigMap', name: 'b', modified: false, liveState: '{"x":1}', targetState: '{"x":1}' },
            { kind: 'ConfigMap', name: 'c', liveState: '{"x":1}', targetState: '{"x":2}' },
        ] as never);
        expect(diffs.map((d) => d.name)).toEqual(['a']);
    });

    it('renders a patch with add and remove counts', () => {
        const [diff] = toAttachmentDiffs([
            {
                group: 'apps',
                kind: 'Deployment',
                namespace: 'prod',
                name: 'api',
                modified: true,
                liveState: JSON.stringify({ spec: { replicas: 2 } }),
                targetState: JSON.stringify({ spec: { replicas: 3 } }),
            },
        ] as never);
        expect(diff?.group).toBe('apps');
        expect(diff?.namespace).toBe('prod');
        expect(diff?.patch).toContain('replicas');
        expect(diff?.added).toBeGreaterThan(0);
        expect(diff?.removed).toBeGreaterThan(0);
    });

    it('prefers the normalized and predicted states Argo CD actually compares', () => {
        // The raw states carry fields Argo CD deliberately ignores; diffing them would show
        // phantom changes the user cannot act on.
        const [diff] = toAttachmentDiffs([
            {
                kind: 'ConfigMap',
                name: 'cm',
                modified: true,
                liveState: JSON.stringify({ ignored: true }),
                targetState: JSON.stringify({ ignored: false }),
                normalizedLiveState: JSON.stringify({ real: 'live' }),
                predictedLiveState: JSON.stringify({ real: 'desired' }),
            },
        ] as never);
        expect(diff?.patch).toContain('live');
        expect(diff?.patch).toContain('desired');
        expect(diff?.patch).not.toContain('ignored');
    });

    it('marks an oversized resource truncated rather than emitting a huge patch', () => {
        const huge = JSON.stringify(Object.fromEntries([...Array(3000).keys()].map((i) => [`k${i}`, i])));
        const [diff] = toAttachmentDiffs([
            { kind: 'ConfigMap', name: 'big', modified: true, liveState: huge, targetState: huge },
        ] as never);
        expect(diff?.truncated).toBe(true);
    });
});

describe('toAttachmentHistory', () => {
    it('sorts newest first, tolerating the int64-as-string id', () => {
        // `id` is int64 upstream, so it arrives as a number or a string depending on size.
        const history = toAttachmentHistory([
            { id: 1, revision: SHA_A },
            { id: '10', revision: SHA_B },
            { id: 2, revision: SHA_A },
        ] as never);
        expect(history.map((h) => h.id)).toEqual(['10', 2, 1]);
    });

    it('reads a multi-source revision from the plural field', () => {
        const [entry] = toAttachmentHistory([{ id: 1, revision: '', revisions: ['1.2.3', SHA_B] }] as never);
        expect(entry?.revision).toBe(`1.2.3,${SHA_B}`);
    });

    it('falls back from chart to path for the source label', () => {
        const [chart] = toAttachmentHistory([{ id: 1, source: { chart: 'redis', path: 'ignored' } }] as never);
        const [path] = toAttachmentHistory([{ id: 1, source: { path: 'charts/api' } }] as never);
        expect(chart?.source).toBe('redis');
        expect(path?.source).toBe('charts/api');
    });
});

describe('toAttachmentResources', () => {
    it('keeps only resources that are not healthy', () => {
        const resources = toAttachmentResources([
            { kind: 'Pod', name: 'ok', health: { status: 'Healthy' } },
            { kind: 'Pod', name: 'bad', health: { status: 'Degraded', message: 'crash loop' } },
            { kind: 'Pod', name: 'no-health' },
        ] as never);
        expect(resources.map((r) => r.name)).toEqual(['bad']);
        expect(resources[0]?.message).toBe('crash loop');
    });

    it('keeps a status it has never seen rather than dropping the row', () => {
        // Argo CD adds health statuses between minors. Anything not Healthy is worth showing.
        const resources = toAttachmentResources([
            { kind: 'Pod', name: 'x', health: { status: 'SomethingNew' } },
        ] as never);
        expect(resources).toHaveLength(1);
    });
});
