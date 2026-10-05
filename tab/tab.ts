// The "Argo CD" build-results tab.
//
// Renders the run attachments published by the Argo CD pipeline tasks. Bundled by webpack --
// NOT esbuild, which the rest of this repo uses -- because azure-devops-extension-api ships
// only AMD modules. See webpack.config.js.
//
// CONTENT SECURITY POLICY: this tab runs inside an iframe under a strict host CSP, and the
// data it renders comes from a cluster. Every node below is built with createElement and
// textContent. There is no innerHTML anywhere in this file and there must never be, or an
// application name or a diff line becomes a script injection vector.

import * as SDK from 'azure-devops-extension-sdk';
import { CommonServiceIds, getClient, type IProjectPageService } from 'azure-devops-extension-api';
import { BuildRestClient, BuildServiceIds, type IBuildPageDataService } from 'azure-devops-extension-api/Build';

import { RUN_ATTACHMENT_TYPE, type RunAttachment } from '../packages/task-common/src/attachment';
import {
    countApplications,
    describeRun,
    diffLineClass,
    healthTone,
    parseAttachmentHref,
    resolveBuildContext,
    phaseTone,
    shortRevision,
    syncTone,
    type AttachmentRef,
    type Tone,
} from './model';

/** Fetches one attachment's parsed content. Injected so the dev harness can use fixtures. */
export type RunFetcher = (ref: AttachmentRef) => Promise<RunAttachment>;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

interface ElOptions {
    className?: string;
    text?: string;
    href?: string;
    attrs?: Record<string, string>;
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: ElOptions = {},
    children: readonly (Node | undefined)[] = [],
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (options.className !== undefined) {
        node.className = options.className;
    }
    if (options.text !== undefined) {
        node.textContent = options.text;
    }
    if (options.href !== undefined) {
        node.setAttribute('href', options.href);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
    }
    for (const [key, value] of Object.entries(options.attrs ?? {})) {
        node.setAttribute(key, value);
    }
    for (const child of children) {
        if (child !== undefined) {
            node.appendChild(child);
        }
    }
    return node;
}

function pill(text: string | undefined, tone: Tone): HTMLElement {
    return el('span', { className: `pill pill-${tone}`, text: text ?? 'Unknown' });
}

function cell(content: Node | string): HTMLTableCellElement {
    return typeof content === 'string' ? el('td', { text: content }) : el('td', {}, [content]);
}

function table(headings: readonly string[], rows: readonly HTMLTableRowElement[]): HTMLElement {
    return el('table', {}, [
        el('thead', {}, [el('tr', {}, headings.map((h) => el('th', { text: h })))]),
        el('tbody', {}, rows),
    ]);
}

function section(title: string, body: Node): HTMLElement {
    return el('div', { className: 'section' }, [el('div', { className: 'section-title', text: title }), body]);
}

function statusBlock(title: string, detail?: string, kind = ''): HTMLElement {
    return el('div', { className: `status ${kind}`.trim() }, [
        el('div', { className: 'status-title', text: title }),
        detail === undefined ? undefined : el('div', { text: detail }),
    ]);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderHead(run: RunAttachment): HTMLElement {
    const meta: string[] = [];
    if (run.finishedAt !== undefined) {
        meta.push(new Date(run.finishedAt).toLocaleString());
    }
    if (run.serverUrl !== undefined) {
        meta.push(run.serverUrl);
    }
    return el('div', { className: 'run-head' }, [
        el('div', { className: 'run-title', text: describeRun(run, 'Argo CD') }),
        meta.length === 0 ? undefined : el('div', { className: 'run-meta', text: meta.join('  ·  ') }),
    ]);
}

function renderCards(run: RunAttachment): HTMLElement | undefined {
    const counts = countApplications(run);
    if (counts.total === 0) {
        return undefined;
    }
    const card = (count: number, label: string, tone: string): HTMLElement =>
        el('div', { className: `card card-${tone}` }, [
            el('div', { className: 'card-count', text: String(count) }),
            el('div', { className: 'card-label', text: label }),
        ]);

    return el('div', { className: 'cards' }, [
        card(counts.total, counts.total === 1 ? 'Application' : 'Applications', 'busy'),
        card(counts.synced, 'Synced', 'ok'),
        counts.outOfSync > 0 ? card(counts.outOfSync, 'Out of sync', 'warn') : undefined,
        counts.unhealthy > 0 ? card(counts.unhealthy, 'Not healthy', 'bad') : undefined,
    ]);
}

function renderApplications(run: RunAttachment): HTMLElement | undefined {
    const apps = run.applications ?? [];
    if (apps.length === 0) {
        return undefined;
    }
    const rows = apps.map((app) => {
        const name = app.url !== undefined ? el('a', { href: app.url, text: app.name }) : el('span', { text: app.name });
        const revision = el('span', { className: 'mono', text: shortRevision(app.revision) });
        const phase =
            app.operationPhase === undefined
                ? el('span', { className: 'muted', text: '-' })
                : pill(app.operationPhase, phaseTone(app.operationPhase));
        return el('tr', {}, [
            cell(name),
            cell(app.project ?? '-'),
            cell(pill(app.syncStatus, syncTone(app.syncStatus))),
            cell(pill(app.healthStatus, healthTone(app.healthStatus))),
            cell(revision),
            cell(phase),
        ]);
    });
    return section('Applications', table(['Application', 'Project', 'Sync', 'Health', 'Revision', 'Operation'], rows));
}

function renderUnhealthy(run: RunAttachment): HTMLElement | undefined {
    const resources = run.unhealthy ?? [];
    if (resources.length === 0) {
        return undefined;
    }
    const rows = resources.map((r) =>
        el('tr', {}, [
            cell(el('span', { className: 'mono', text: [r.group, r.kind].filter(Boolean).join('/') || '-' })),
            cell([r.namespace, r.name].filter(Boolean).join('/') || '-'),
            cell(pill(r.health, healthTone(r.health))),
            cell(r.message ?? ''),
        ]),
    );
    return section('Unhealthy resources', table(['Kind', 'Name', 'Health', 'Message'], rows));
}

function renderPatch(patch: string): HTMLElement {
    const pre = el('pre', { className: 'patch' });
    for (const line of patch.split('\n')) {
        const className = diffLineClass(line);
        // One element per line so each can carry its own background, and textContent
        // throughout so a diff can never inject markup.
        pre.appendChild(el('span', { className, text: `${line}\n` }));
    }
    return pre;
}

function renderDiffs(run: RunAttachment): HTMLElement | undefined {
    const diffs = run.diffs ?? [];
    if (diffs.length === 0) {
        return undefined;
    }
    const blocks = diffs.map((d) => {
        const label = `${[d.group, d.kind].filter(Boolean).join('/')} ${[d.namespace, d.name].filter(Boolean).join('/')}`;
        const counts = el('span', { className: 'diff-counts' }, [
            el('span', { className: 'add', text: `+${d.added}` }),
            el('span', { text: ' ' }),
            el('span', { className: 'del', text: `-${d.removed}` }),
        ]);
        const summary = el('summary', {}, [el('span', { text: label.trim() }), counts]);
        const body = d.truncated === true ? el('pre', { className: 'patch', text: d.patch }) : renderPatch(d.patch);
        return el('details', { className: 'diff' }, [summary, body]);
    });
    return section(diffs.length === 1 ? '1 resource differs' : `${diffs.length} resources differ`, el('div', {}, blocks));
}

function renderHistory(run: RunAttachment): HTMLElement | undefined {
    const entries = run.history ?? [];
    if (entries.length === 0) {
        return undefined;
    }
    const rows = entries.map((h) =>
        el('tr', {}, [
            cell(String(h.id ?? '?')),
            cell(el('span', { className: 'mono', text: shortRevision(h.revision) })),
            cell(h.deployedAt === undefined ? '-' : new Date(h.deployedAt).toLocaleString()),
            cell(h.source ?? '-'),
        ]),
    );
    return section('Deployment history', table(['ID', 'Revision', 'Deployed', 'Source'], rows));
}

function renderGenerated(run: RunAttachment): HTMLElement | undefined {
    const apps = run.generatedApps ?? [];
    if (apps.length === 0) {
        return undefined;
    }
    const rows = apps.map((a) =>
        el('tr', {}, [
            cell(a.name ?? '-'),
            cell(a.project ?? '-'),
            cell(a.namespace ?? '-'),
            cell(el('span', { className: 'mono', text: a.server ?? '-' })),
        ]),
    );
    return section(
        apps.length === 1 ? '1 generated application' : `${apps.length} generated applications`,
        table(['Application', 'Project', 'Namespace', 'Destination'], rows),
    );
}

function renderTokens(run: RunAttachment): HTMLElement | undefined {
    const tokens = run.tokens ?? [];
    if (tokens.length === 0) {
        return undefined;
    }
    const when = (seconds: number | undefined): string =>
        seconds === undefined || seconds === 0 ? 'never' : new Date(seconds * 1000).toLocaleString();
    const rows = tokens.map((t) =>
        el('tr', {}, [
            cell(el('span', { className: 'mono', text: t.id ?? '-' })),
            cell(t.subject ?? '-'),
            cell(when(t.issuedAt)),
            cell(when(t.expiresAt)),
        ]),
    );
    // Only ever ids and timestamps. The token value has no field in the payload at all.
    return section('Tokens', table(['ID', 'Subject', 'Issued', 'Expires'], rows));
}

function renderNotes(run: RunAttachment): HTMLElement | undefined {
    const notes = run.notes ?? [];
    if (notes.length === 0) {
        return undefined;
    }
    return section('Details', el('ul', { className: 'notes' }, notes.map((n) => el('li', { text: n }))));
}

/** Render one run into a fresh element. Exported for the dev harness. */
export function renderRun(run: RunAttachment): HTMLElement {
    const body = el('div', {}, [
        renderHead(run),
        run.result === 'Failed' && run.error !== undefined
            ? el('div', { className: 'failed-banner' }, [el('strong', { text: 'Failed: ' }), el('span', { text: run.error })])
            : undefined,
        renderCards(run),
        renderApplications(run),
        renderUnhealthy(run),
        renderDiffs(run),
        renderGenerated(run),
        renderHistory(run),
        renderTokens(run),
        renderNotes(run),
    ]);
    if (body.childElementCount === 0) {
        return statusBlock('This step published no details.');
    }
    return body;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Render every attachment, with a selector when a build ran more than one Argo CD step.
 *
 * The selector lives in a persistent header and only the body is swapped, so changing step
 * never re-creates the dropdown underneath the pointer.
 */
export async function renderRuns(refs: readonly AttachmentRef[], fetch: RunFetcher, root: HTMLElement): Promise<void> {
    root.textContent = '';
    if (refs.length === 0) {
        root.appendChild(
            statusBlock('No Argo CD results in this build.', 'A step must run an Argo CD task with publishSummary enabled.'),
        );
        return;
    }

    const bar = el('div', { className: 'step-bar' });
    const body = el('div', {});
    root.appendChild(bar);
    root.appendChild(body);

    let current = refs[0] as AttachmentRef;

    const show = async (ref: AttachmentRef): Promise<void> => {
        body.textContent = '';
        body.appendChild(statusBlock('Loading…'));
        try {
            const run = await fetch(ref);
            // Guard against a slow fetch landing after the user moved on.
            if (ref !== current) {
                return;
            }
            body.textContent = '';
            body.appendChild(renderRun(run));
        } catch (error) {
            if (ref !== current) {
                return;
            }
            body.textContent = '';
            body.appendChild(statusBlock('Could not load this result.', String(error), 'status-error'));
        }
    };

    if (refs.length > 1) {
        // The label needs `for` pointing at the select, or clicking it does not focus the
        // control and a screen reader cannot derive the control's name.
        const selectId = 'argocd-step-select';
        const select = el('select', { attrs: { id: selectId } });
        refs.forEach((ref, index) => {
            select.appendChild(el('option', { text: ref.name, attrs: { value: String(index) } }));
        });
        select.addEventListener('change', () => {
            current = refs[select.selectedIndex] as AttachmentRef;
            void show(current);
        });
        bar.appendChild(el('label', { text: 'Step', attrs: { for: selectId } }));
        bar.appendChild(select);
    }

    await show(current);
}

// ---------------------------------------------------------------------------
// Azure DevOps wiring
// ---------------------------------------------------------------------------

interface AttachmentLike {
    name?: string;
    // `_links` is typed `any` upstream, so narrow it here rather than trusting it.
    _links?: { self?: { href?: string } };
}

async function listRuns(): Promise<{ refs: AttachmentRef[]; fetch: RunFetcher }> {
    const projectService = await SDK.getService<IProjectPageService>(CommonServiceIds.ProjectPageService);
    const buildService = await SDK.getService<IBuildPageDataService>(BuildServiceIds.BuildPageDataService);
    // Both are XDM proxies; resolveBuildContext awaits whatever they return, so it is
    // correct whether the SDK's declaration says sync or async. See its doc comment.
    const { projectId, buildId } = await resolveBuildContext(
        () => projectService.getProject(),
        () => buildService.getBuildPageData(),
    );

    const client = getClient(BuildRestClient);
    const attachments = (await client.getAttachments(projectId, buildId, RUN_ATTACHMENT_TYPE)) as AttachmentLike[];

    const refs: AttachmentRef[] = [];
    for (const attachment of attachments) {
        const ref = parseAttachmentHref(attachment.name ?? '', attachment._links?.self?.href);
        if (ref !== undefined) {
            refs.push(ref);
        }
    }

    // Stable order. getAttachments' ordering is not documented, so without sorting the step
    // dropdown can come back in a different order on the same build. The attachment names
    // carry a sequence suffix, so this is also chronological.
    refs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const fetch: RunFetcher = async (ref) => {
        const buffer = await client.getAttachment(projectId, buildId, ref.timelineId, ref.recordId, RUN_ATTACHMENT_TYPE, ref.name);
        return JSON.parse(new TextDecoder().decode(buffer)) as RunAttachment;
    };

    return { refs, fetch };
}

async function bootstrap(): Promise<void> {
    const root = document.getElementById('container');
    if (root === null) {
        return;
    }
    try {
        // loaded:false means we tell the host when we are actually ready, so it keeps its own
        // spinner up instead of showing a half-rendered tab.
        await SDK.init({ loaded: false, applyTheme: true });
        await SDK.ready();
        const { refs, fetch } = await listRuns();
        await renderRuns(refs, fetch, root);
        // Returns a promise: dropping it races the host's own loading state.
        await SDK.notifyLoadSucceeded();
    } catch (error) {
        // .message, not String(error) -- the latter renders as "Error: ..." in the UI.
        const detail = error instanceof Error ? error.message : String(error);
        root.textContent = '';
        root.appendChild(statusBlock('Could not load Argo CD results.', detail, 'status-error'));
        try {
            await SDK.notifyLoadFailed(detail);
        } catch {
            /* SDK may not have initialised; nothing useful to do. */
        }
    }
}

declare global {
    interface Window {
        __ARGOCD_DEV__?: boolean;
    }
}

// The dev harness sets __ARGOCD_DEV__ before this bundle runs and drives renderRuns itself
// against fixtures. Without the guard, bootstrap() would try to reach an Azure DevOps host
// that is not there.
if (window.__ARGOCD_DEV__ !== true) {
    void bootstrap();
}
