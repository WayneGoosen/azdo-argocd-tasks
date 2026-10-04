// Markdown rendering for the pipeline run summary tab.
//
// Pure string building, no I/O, so it snapshots cleanly in tests. The caller writes the
// result to a file and publishes it with ##vso[task.uploadsummary].

import { ResourceDiff, ResourceNode, RevisionHistory, revisionOf } from '@azdo-argocd/argocd-client';
import { renderUnified, stateToLines } from './diff';
import { applicationUrl } from './urls';
import { AppSnapshot } from './wait';

const HEALTH_ICONS: Record<string, string> = {
    Healthy: '&#9989;',
    Progressing: '&#128260;',
    Degraded: '&#10060;',
    Suspended: '&#9208;',
    Missing: '&#10068;',
    Unknown: '&#10067;',
};

const SYNC_ICONS: Record<string, string> = {
    Synced: '&#9989;',
    OutOfSync: '&#9888;',
    Unknown: '&#10067;',
};

function icon(map: Record<string, string>, status: string | undefined): string {
    return `${map[status ?? 'Unknown'] ?? map['Unknown']} ${status ?? 'Unknown'}`;
}

function shortRevision(revision: string | undefined): string {
    if (revision === undefined || revision === '') {
        return '-';
    }
    // Git SHAs are unreadable at full length in a table; Helm chart versions are not SHAs.
    return /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 7) : revision;
}

export function renderApplicationTable(snapshots: readonly AppSnapshot[], serverUrl: string): string {
    const header = '| Application | Sync | Health | Revision |\n| --- | --- | --- | --- |';
    const rows = snapshots.map((snapshot) => {
        const link = applicationUrl(serverUrl, snapshot.name, snapshot.namespace);
        return `| [${snapshot.name}](${link}) | ${icon(SYNC_ICONS, snapshot.syncStatus)} | ${icon(
            HEALTH_ICONS,
            snapshot.healthStatus,
        )} | \`${shortRevision(snapshot.revision)}\` |`;
    });
    return [header, ...rows].join('\n');
}

export function renderUnhealthyResources(nodes: readonly ResourceNode[]): string {
    const unhealthy = nodes.filter(
        (node) => node.health?.status !== undefined && node.health.status !== 'Healthy',
    );
    if (unhealthy.length === 0) {
        return '';
    }
    const header = '| Kind | Name | Health | Message |\n| --- | --- | --- | --- |';
    const rows = unhealthy.map((node) => {
        const kind = `${node.group === undefined || node.group === '' ? '' : `${node.group}/`}${node.kind ?? '?'}`;
        // Backslashes FIRST. Escaping the pipe alone turns an input of `a\|b` into
        // `a\\|b`, where the doubled backslash renders literally and the pipe is left
        // unescaped -- breaking the table cell. Same ordering trap as percent-encoding.
        const message = (node.health?.message ?? '')
            .replace(/\\/g, '\\\\')
            .replace(/\|/g, '\\|')
            .replace(/\n/g, ' ');
        return `| \`${kind}\` | ${node.name ?? '?'} | ${node.health?.status ?? 'Unknown'} | ${message} |`;
    });
    return ['#### Unhealthy resources', '', header, ...rows].join('\n');
}

export function renderResourceDiff(resource: ResourceDiff): string {
    const kind = `${resource.group === undefined || resource.group === '' ? '' : `${resource.group}/`}${
        resource.kind ?? '?'
    }`;
    const title = `${kind} ${resource.namespace === undefined ? '' : `${resource.namespace}/`}${resource.name ?? '?'}`;

    const live = stateToLines(resource.normalizedLiveState ?? resource.liveState);
    const desired = stateToLines(resource.predictedLiveState ?? resource.targetState);
    const rendered = renderUnified(live, desired);

    const counts = rendered.truncated ? '' : ` (+${rendered.addedLines}/-${rendered.removedLines})`;
    return [
        '<details>',
        `<summary><code>${title}</code>${counts}</summary>`,
        '',
        '```diff',
        rendered.text,
        '```',
        '',
        '</details>',
    ].join('\n');
}

export interface DiffSummaryInput {
    applicationName: string;
    serverUrl: string;
    appNamespace?: string | undefined;
    resources: readonly ResourceDiff[];
}

export function renderDiffSummary(input: DiffSummaryInput): string {
    const changed = input.resources.filter((resource) => resource.modified === true);
    const link = applicationUrl(input.serverUrl, input.applicationName, input.appNamespace);
    const heading = `### Argo CD diff &mdash; [${input.applicationName}](${link})`;

    if (changed.length === 0) {
        return [heading, '', 'No differences between the desired and live state.'].join('\n');
    }

    return [
        heading,
        '',
        `${changed.length} resource(s) differ from the desired state.`,
        '',
        ...changed.map(renderResourceDiff),
    ].join('\n\n');
}

export interface StatusSummaryInput {
    title: string;
    serverUrl: string;
    snapshots: readonly AppSnapshot[];
    unhealthyNodes?: readonly ResourceNode[];
    footer?: string | undefined;
}

export function renderStatusSummary(input: StatusSummaryInput): string {
    const sections = [`### ${input.title}`, '', renderApplicationTable(input.snapshots, input.serverUrl)];

    const unhealthy = renderUnhealthyResources(input.unhealthyNodes ?? []);
    if (unhealthy !== '') {
        sections.push('', unhealthy);
    }
    if (input.footer !== undefined && input.footer !== '') {
        sections.push('', input.footer);
    }
    return sections.join('\n');
}

/**
 * Render `status.history[]` as a table.
 *
 * `id` is an int64 upstream, so it may arrive as a number or a string; both are rendered.
 */
export function renderHistoryTable(entries: readonly RevisionHistory[]): string {
    if (entries.length === 0) {
        return 'No deployment history. The application has not been synced yet.';
    }
    const header = '| ID | Revision | Deployed at | Source |\n| --- | --- | --- | --- |';
    const rows = [...entries]
        .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0))
        .map((entry) => {
            const source = entry.source?.chart ?? entry.source?.path ?? '-';
            return `| ${entry.id ?? '?'} | \`${shortRevision(revisionOf(entry))}\` | ${
                entry.deployedAt ?? '-'
            } | ${source} |`;
        });
    return [header, ...rows].join('\n');
}

export interface HistorySummaryInput {
    applicationName: string;
    serverUrl: string;
    appNamespace?: string | undefined;
    entries: readonly RevisionHistory[];
}

export function renderHistorySummary(input: HistorySummaryInput): string {
    const link = applicationUrl(input.serverUrl, input.applicationName, input.appNamespace);
    return [
        `### Deployment history &mdash; [${input.applicationName}](${link})`,
        '',
        renderHistoryTable(input.entries),
    ].join('\n');
}
