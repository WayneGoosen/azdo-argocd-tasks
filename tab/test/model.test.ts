// Tests for the tab's pure logic.
//
// The reference implementation this pattern came from has no tab tests at all. The pieces
// below are the ones that fail SILENTLY in a browser iframe -- a bad href regex yields an
// empty tab with nothing in any log -- so they are worth more than the rendering code.

import { describe, expect, it } from 'vitest';
import {
    countApplications,
    resolveBuildContext,
    describeRun,
    diffLineClass,
    healthTone,
    parseAttachmentHref,
    shortRevision,
    syncTone,
} from '../model';
import type { RunAttachment } from '../../packages/task-common/src/attachment';

const run = (over: Partial<RunAttachment> = {}): RunAttachment => ({ schema: 1, task: 'ArgoCDApp@1', ...over });

describe('parseAttachmentHref', () => {
    // getAttachments() returns name + _links only; getAttachment() needs timelineId and
    // recordId, which exist nowhere as fields. They can only be read out of this href.
    const timeline = '11111111-2222-3333-4444-555555555555';
    const record = '66666666-7777-8888-9999-000000000000';

    it('parses a dev.azure.com href', () => {
        const href = `https://dev.azure.com/org/proj/_apis/build/builds/42/${timeline}/${record}/attachments/argocd-tasks.run/x`;
        expect(parseAttachmentHref('x', href)).toEqual({ name: 'x', timelineId: timeline, recordId: record });
    });

    it('parses the legacy visualstudio.com href', () => {
        const href = `https://org.visualstudio.com/proj/_apis/build/builds/7/${timeline}/${record}/attachments/argocd-tasks.run/x`;
        expect(parseAttachmentHref('x', href)?.recordId).toBe(record);
    });

    it('returns undefined rather than throwing on an unusable link', () => {
        // _links is typed `any` upstream, so absence and nonsense both have to be survivable.
        expect(parseAttachmentHref('x', undefined)).toBeUndefined();
        expect(parseAttachmentHref('x', 'https://example.com/nope')).toBeUndefined();
        expect(parseAttachmentHref('x', '')).toBeUndefined();
    });
});

describe('status tones', () => {
    it('maps the known Argo CD statuses', () => {
        expect(healthTone('Healthy')).toBe('ok');
        expect(healthTone('Degraded')).toBe('bad');
        expect(healthTone('Progressing')).toBe('busy');
        expect(syncTone('Synced')).toBe('ok');
        expect(syncTone('OutOfSync')).toBe('warn');
    });

    it('falls back to neutral for a status it has never heard of', () => {
        // Argo CD adds statuses between minors. An unknown one must render as itself, not
        // crash the tab and not be miscoloured as a failure.
        expect(healthTone('SomethingNew')).toBe('idle');
        expect(syncTone('SomethingNew')).toBe('idle');
        expect(healthTone(undefined)).toBe('idle');
    });
});

describe('shortRevision', () => {
    it('shortens a git SHA', () => {
        expect(shortRevision('a'.repeat(40))).toBe('aaaaaaa');
    });

    it('leaves a Helm chart version intact', () => {
        expect(shortRevision('1.2.3')).toBe('1.2.3');
    });

    it('handles a multi-source revision of mixed kinds', () => {
        // The common chart-plus-values-repo app: a chart version and a SHA, joined.
        expect(shortRevision(`1.2.3,${'b'.repeat(40)}`)).toBe('1.2.3, bbbbbbb');
    });

    it('renders nothing as a dash', () => {
        expect(shortRevision(undefined)).toBe('-');
        expect(shortRevision('')).toBe('-');
    });
});

describe('countApplications', () => {
    it('counts sync and health independently', () => {
        const counts = countApplications(
            run({
                applications: [
                    { name: 'a', syncStatus: 'Synced', healthStatus: 'Healthy' },
                    { name: 'b', syncStatus: 'OutOfSync', healthStatus: 'Degraded' },
                    { name: 'c', syncStatus: 'Synced', healthStatus: 'Progressing' },
                ],
            }),
        );
        expect(counts).toEqual({ total: 3, synced: 2, outOfSync: 1, healthy: 1, unhealthy: 2 });
    });

    it('does not count an absent health status as unhealthy', () => {
        const counts = countApplications(run({ applications: [{ name: 'a' }] }));
        expect(counts.unhealthy).toBe(0);
        expect(counts.healthy).toBe(0);
    });

    it('survives a payload with no applications at all', () => {
        expect(countApplications(run()).total).toBe(0);
    });
});

describe('diffLineClass', () => {
    it('colours additions and removals', () => {
        expect(diffLineClass('+  replicas: 3')).toBe('l-add');
        expect(diffLineClass('-  replicas: 2')).toBe('l-del');
        expect(diffLineClass('@@ -1,4 +1,4 @@')).toBe('l-hunk');
        expect(diffLineClass('   unchanged')).toBe('');
    });

    it('does not mistake file headers for content', () => {
        // `---`/`+++` start with - and + but are headers. Colouring them is the classic
        // off-by-one in naive diff highlighting.
        expect(diffLineClass('--- live')).toBe('');
        expect(diffLineClass('+++ desired')).toBe('');
    });
});

describe('describeRun', () => {
    it('names a step when the agent gave us one', () => {
        expect(describeRun(run({ command: 'sync', step: 'Deploy payments' }), 'x')).toBe(
            'Deploy payments (ArgoCDApp@1 · sync)',
        );
    });

    it('falls back to task and command', () => {
        expect(describeRun(run({ command: 'diff' }), 'x')).toBe('ArgoCDApp@1 · diff');
    });

    it('falls back to the attachment name when there is no run', () => {
        expect(describeRun(undefined, 'attachment-1')).toBe('attachment-1');
    });
});

describe('resolveBuildContext', () => {
    const project = { id: 'proj-guid' };
    const pageData = { build: { id: 4242 } };

    it('works when the services return PROMISES, which is what they actually do', async () => {
        // This is the real shape. Everything from SDK.getService() is an XDM proxy and every
        // method on it returns a Promise -- even the ones the .d.ts declares synchronous.
        // Trusting the declaration and dropping the await shipped a broken tab in 1.0.15,
        // where the tab reported "could not identify the build it is attached to".
        const ctx = await resolveBuildContext(
            () => Promise.resolve(project),
            () => Promise.resolve(pageData),
        );
        expect(ctx).toEqual({ projectId: 'proj-guid', buildId: 4242 });
    });

    it('also works when they return values directly, as the types claim', async () => {
        // Awaiting a non-promise is a no-op, so the resolver is correct either way and the
        // tab cannot break again if the SDK changes which it does.
        const ctx = await resolveBuildContext(
            () => project,
            () => pageData,
        );
        expect(ctx).toEqual({ projectId: 'proj-guid', buildId: 4242 });
    });

    it('names the project as the missing piece, not just "something failed"', async () => {
        await expect(
            resolveBuildContext(() => undefined, () => Promise.resolve(pageData)),
        ).rejects.toThrow(/project context/i);
    });

    it('names the build, and says where the tab does work', async () => {
        await expect(
            resolveBuildContext(() => Promise.resolve(project), () => Promise.resolve({})),
        ).rejects.toThrow(/build context/i);
    });

    it('rejects a non-numeric build id rather than passing it to the REST client', async () => {
        await expect(
            resolveBuildContext(
                () => Promise.resolve(project),
                () => Promise.resolve({ build: { id: '4242' } }),
            ),
        ).rejects.toThrow(/build context/i);
    });
});
