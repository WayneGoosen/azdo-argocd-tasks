// Pure logic for the Argo CD tab: no DOM, no SDK, no network.
//
// Everything here is unit-testable in a plain Node environment, which is the point. The
// rendering in tab.ts is thin on top of this, so the parts that fail SILENTLY -- the
// attachment href parsing especially -- are covered by tests rather than by opening a
// pipeline and squinting at it.

import type { RunAttachment } from '../packages/task-common/src/attachment';

/** Semantic bucket a status falls into, which drives colour and nothing else. */
export type Tone = 'ok' | 'warn' | 'bad' | 'busy' | 'suspended' | 'idle';

/**
 * Argo CD adds sync and health statuses between minor versions, so this must never be an
 * exhaustive switch. Anything unrecognised renders with neutral styling and its own text --
 * a new status shows up as itself rather than as a crash or a blank cell.
 */
const HEALTH_TONES: Record<string, Tone> = {
    Healthy: 'ok',
    Progressing: 'busy',
    Degraded: 'bad',
    Suspended: 'suspended',
    Missing: 'warn',
    Unknown: 'idle',
};

const SYNC_TONES: Record<string, Tone> = {
    Synced: 'ok',
    OutOfSync: 'warn',
    Unknown: 'idle',
};

const PHASE_TONES: Record<string, Tone> = {
    Succeeded: 'ok',
    Running: 'busy',
    Terminating: 'busy',
    Failed: 'bad',
    Error: 'bad',
    Terminated: 'warn',
};

export function healthTone(status: string | undefined): Tone {
    return status === undefined ? 'idle' : (HEALTH_TONES[status] ?? 'idle');
}

export function syncTone(status: string | undefined): Tone {
    return status === undefined ? 'idle' : (SYNC_TONES[status] ?? 'idle');
}

export function phaseTone(phase: string | undefined): Tone {
    return phase === undefined ? 'idle' : (PHASE_TONES[phase] ?? 'idle');
}

/**
 * Shorten a git SHA for display, leaving anything else alone.
 *
 * A multi-source application reports one revision per source and they are NOT all SHAs: a
 * Helm chart source reports its chart version. Truncating `1.2.3` to seven characters would
 * be meaningless, so only a full 40-hex SHA is shortened.
 */
export function shortRevision(revision: string | undefined): string {
    if (revision === undefined || revision === '') {
        return '-';
    }
    return revision
        .split(',')
        .map((part) => (/^[0-9a-f]{40}$/i.test(part) ? part.slice(0, 7) : part))
        .join(', ');
}

export interface Counts {
    total: number;
    synced: number;
    outOfSync: number;
    healthy: number;
    unhealthy: number;
}

/** Headline counts for the cards. Unknown statuses count toward neither side. */
export function countApplications(run: RunAttachment): Counts {
    const apps = run.applications ?? [];
    return {
        total: apps.length,
        synced: apps.filter((a) => a.syncStatus === 'Synced').length,
        outOfSync: apps.filter((a) => a.syncStatus === 'OutOfSync').length,
        healthy: apps.filter((a) => a.healthStatus === 'Healthy').length,
        unhealthy: apps.filter((a) => a.healthStatus !== undefined && a.healthStatus !== 'Healthy').length,
    };
}

/** Identifies one attachment well enough to fetch its content. */
export interface AttachmentRef {
    name: string;
    timelineId: string;
    recordId: string;
}

/**
 * Pull the timeline and record ids out of an attachment's self link.
 *
 * `getAttachments()` returns a name and `_links` only, but `getAttachment()` demands
 * (project, buildId, timelineId, recordId, type, name). Those two ids exist NOWHERE as
 * fields -- they are only embedded in the href, and `_links` is typed `any` upstream. Both
 * host shapes must parse:
 *
 *   https://dev.azure.com/{org}/{proj}/_apis/build/builds/{id}/{timeline}/{record}/attachments/{type}/{name}
 *   https://{org}.visualstudio.com/{proj}/_apis/build/builds/{id}/{timeline}/{record}/attachments/{type}/{name}
 *
 * Returns undefined for an href that does not match, so the caller can skip that attachment
 * rather than render a broken row.
 */
export function parseAttachmentHref(name: string, href: string | undefined): AttachmentRef | undefined {
    if (typeof href !== 'string') {
        return undefined;
    }
    const match = href.match(/\/builds\/\d+\/([0-9a-fA-F-]+)\/([0-9a-fA-F-]+)\/attachments\//);
    if (match === null || match[1] === undefined || match[2] === undefined) {
        return undefined;
    }
    return { name, timelineId: match[1], recordId: match[2] };
}

/** Label for the step selector. Falls back through step name, command, then attachment name. */
export function describeRun(run: RunAttachment | undefined, fallback: string): string {
    if (run === undefined) {
        return fallback;
    }
    const parts = [run.task, run.command].filter((p): p is string => p !== undefined && p !== '');
    const base = parts.length > 0 ? parts.join(' · ') : fallback;
    return run.step !== undefined && run.step !== '' ? `${run.step} (${base})` : base;
}

/**
 * Classify one line of a unified diff for colouring.
 *
 * `---`/`+++` are file headers, not content, so they must not be coloured as a removal and an
 * addition -- that is the usual off-by-one in naive diff highlighting.
 */
export function diffLineClass(line: string): string {
    if (line.startsWith('@@')) {
        return 'l-hunk';
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
        return '';
    }
    if (line.startsWith('+')) {
        return 'l-add';
    }
    if (line.startsWith('-')) {
        return 'l-del';
    }
    return '';
}
