import { describe, expect, it } from 'vitest';
import {
    renderApplicationTable,
    renderDiffSummary,
    renderStatusSummary,
    renderUnhealthyResources,
} from '../src/summary';
import { applicationUrl } from '../src/urls';

const SERVER = 'https://argocd.example.com';

describe('applicationUrl', () => {
    it('links to the plain application path when no namespace is given', () => {
        expect(applicationUrl(SERVER, 'payments')).toBe(`${SERVER}/applications/payments`);
    });

    it('includes the namespace for app-in-any-namespace installs', () => {
        expect(applicationUrl(SERVER, 'payments', 'team-a')).toBe(`${SERVER}/applications/team-a/payments`);
    });

    it('tolerates a trailing slash on the server URL', () => {
        expect(applicationUrl(`${SERVER}/`, 'payments')).toBe(`${SERVER}/applications/payments`);
    });
});

describe('renderApplicationTable', () => {
    it('renders one row per application with a deep link', () => {
        const table = renderApplicationTable(
            [{ name: 'payments', syncStatus: 'Synced', healthStatus: 'Healthy', revision: 'abc1234' }],
            SERVER,
        );
        expect(table).toContain('[payments](https://argocd.example.com/applications/payments)');
        expect(table).toContain('Synced');
        expect(table).toContain('Healthy');
    });

    it('shortens a full git SHA but leaves other revisions alone', () => {
        const table = renderApplicationTable(
            [
                { name: 'a', revision: 'a'.repeat(40) },
                { name: 'b', revision: '1.2.3' },
            ],
            SERVER,
        );
        expect(table).toContain('`aaaaaaa`');
        expect(table).toContain('`1.2.3`');
    });

    it('shows Unknown rather than blanks for missing status', () => {
        expect(renderApplicationTable([{ name: 'a' }], SERVER)).toContain('Unknown');
    });
});

describe('renderUnhealthyResources', () => {
    it('is empty when everything is healthy', () => {
        expect(renderUnhealthyResources([{ kind: 'Pod', health: { status: 'Healthy' } }])).toBe('');
    });

    it('lists only unhealthy resources', () => {
        const rendered = renderUnhealthyResources([
            { kind: 'Pod', name: 'ok', health: { status: 'Healthy' } },
            { kind: 'Deployment', name: 'broken', health: { status: 'Degraded', message: 'crash loop' } },
        ]);
        expect(rendered).toContain('broken');
        expect(rendered).not.toContain('| ok |');
        expect(rendered).toContain('crash loop');
    });

    it('escapes a backslash before the pipe it precedes', () => {
        // Escaping `|` alone turns `a\\|b` into `a\\\\|b`: the doubled backslash renders
        // literally and the pipe is then unescaped, splitting the cell. Found by CodeQL.
        const rendered = renderUnhealthyResources([
            { kind: 'Pod', name: 'p', health: { status: 'Degraded', message: 'a\\|b' } },
        ] as never);
        expect(rendered).toContain('a\\\\\\|b');
        // The escaped pipe is still a `|` character, so count only UNESCAPED ones: four
        // columns means five separators, and nothing from the message may add a sixth.
        const row = rendered.split('\n').find((l) => l.includes('Degraded')) ?? '';
        const unescaped = row.match(/(?<!\\)\|/g) ?? [];
        expect(unescaped.length, 'the message leaked an unescaped pipe into the row').toBe(5);
    });

    it('escapes pipes so a message cannot break the table', () => {
        const rendered = renderUnhealthyResources([
            { kind: 'Pod', name: 'p', health: { status: 'Degraded', message: 'a | b' } },
        ]);
        expect(rendered).toContain('a \\| b');
    });

    it('flattens newlines in a message', () => {
        const rendered = renderUnhealthyResources([
            { kind: 'Pod', name: 'p', health: { status: 'Degraded', message: 'line1\nline2' } },
        ]);
        expect(rendered).not.toMatch(/line1\nline2/);
    });
});

describe('renderDiffSummary', () => {
    it('says so plainly when there is nothing to show', () => {
        expect(
            renderDiffSummary({ applicationName: 'payments', serverUrl: SERVER, resources: [] }),
        ).toContain('No differences');
    });

    it('ignores unmodified resources', () => {
        const summary = renderDiffSummary({
            applicationName: 'payments',
            serverUrl: SERVER,
            resources: [{ kind: 'ConfigMap', name: 'same', modified: false }],
        });
        expect(summary).toContain('No differences');
    });

    it('renders a collapsible diff block per modified resource', () => {
        const summary = renderDiffSummary({
            applicationName: 'payments',
            serverUrl: SERVER,
            resources: [
                {
                    group: 'apps',
                    kind: 'Deployment',
                    namespace: 'prod',
                    name: 'api',
                    modified: true,
                    liveState: JSON.stringify({ replicas: 2 }),
                    targetState: JSON.stringify({ replicas: 3 }),
                },
            ],
        });
        expect(summary).toContain('<details>');
        expect(summary).toContain('apps/Deployment prod/api');
        expect(summary).toContain('```diff');
        expect(summary).toContain('1 resource(s) differ');
    });

    it('prefers normalized and predicted state, which is what Argo CD compares', () => {
        const summary = renderDiffSummary({
            applicationName: 'payments',
            serverUrl: SERVER,
            resources: [
                {
                    kind: 'ConfigMap',
                    name: 'cm',
                    modified: true,
                    liveState: JSON.stringify({ ignored: true }),
                    normalizedLiveState: JSON.stringify({ key: 'live' }),
                    targetState: JSON.stringify({ ignored: true }),
                    predictedLiveState: JSON.stringify({ key: 'desired' }),
                },
            ],
        });
        expect(summary).toContain('live');
        expect(summary).toContain('desired');
        expect(summary).not.toContain('ignored');
    });
});

describe('renderStatusSummary', () => {
    it('includes the title and the application table', () => {
        const summary = renderStatusSummary({
            title: 'Argo CD application status',
            serverUrl: SERVER,
            snapshots: [{ name: 'payments', syncStatus: 'Synced', healthStatus: 'Healthy' }],
        });
        expect(summary).toContain('### Argo CD application status');
        expect(summary).toContain('payments');
    });

    it('omits the unhealthy section when everything is healthy', () => {
        const summary = renderStatusSummary({
            title: 't',
            serverUrl: SERVER,
            snapshots: [{ name: 'a' }],
            unhealthyNodes: [{ kind: 'Pod', health: { status: 'Healthy' } }],
        });
        expect(summary).not.toContain('Unhealthy resources');
    });

    it('appends a footer when given one', () => {
        const summary = renderStatusSummary({
            title: 't',
            serverUrl: SERVER,
            snapshots: [{ name: 'a' }],
            footer: 'Completed in 12s.',
        });
        expect(summary).toContain('Completed in 12s.');
    });
});
