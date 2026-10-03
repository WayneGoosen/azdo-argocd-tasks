// Converting Argo CD API shapes into the tab's wire contract.
//
// Deliberately separate from ./attachment, which the TAB imports and which must stay free of
// any dependency: this module pulls in the client's types and the diff renderer, neither of
// which belongs in a browser bundle.
//
// The diff conversion goes through the same `stateToLines` + `renderUnified` the Markdown
// summary uses. That matters: the run summary and the tab must not disagree about what
// changed, and the only way to guarantee that is to compute it once.

import type { ResourceDiff, ResourceNode, RevisionHistory } from '@azdo-argocd/argocd-client';
import { revisionOf } from '@azdo-argocd/argocd-client';
import type { AttachmentDiff, AttachmentHistory, AttachmentResource } from './attachment';
import { renderUnified, stateToLines } from './diff';

/**
 * Changed resources, pre-rendered as unified diffs.
 *
 * Only `modified` resources: Argo CD returns every managed resource from the
 * managed-resources endpoint, and shipping the unchanged ones would bloat the attachment
 * with hundreds of empty patches.
 */
export function toAttachmentDiffs(resources: readonly ResourceDiff[]): AttachmentDiff[] {
    return resources
        .filter((resource) => resource.modified === true)
        .map((resource) => {
            // normalized/predicted are the states Argo CD actually compares; the raw ones
            // include fields it deliberately ignores and would show phantom changes.
            const live = stateToLines(resource.normalizedLiveState ?? resource.liveState);
            const desired = stateToLines(resource.predictedLiveState ?? resource.targetState);
            const rendered = renderUnified(live, desired);
            return {
                group: resource.group,
                kind: resource.kind,
                namespace: resource.namespace,
                name: resource.name,
                added: rendered.addedLines,
                removed: rendered.removedLines,
                patch: rendered.text,
                truncated: rendered.truncated,
            };
        });
}

/** Deployment history, newest first, with the revision read from either field shape. */
export function toAttachmentHistory(entries: readonly RevisionHistory[]): AttachmentHistory[] {
    return [...entries]
        .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0))
        .map((entry) => ({
            id: entry.id,
            // revisionOf, not entry.revision: a multi-source app fills `revisions` instead
            // and leaves the singular field present and empty.
            revision: revisionOf(entry),
            deployedAt: entry.deployedAt,
            source: entry.source?.chart ?? entry.source?.path,
        }));
}

/** Resources whose health is worth surfacing. Healthy and unknown-health nodes are dropped. */
export function toAttachmentResources(nodes: readonly ResourceNode[]): AttachmentResource[] {
    return nodes
        .filter((node) => node.health?.status !== undefined && node.health.status !== 'Healthy')
        .map((node) => ({
            group: node.group,
            kind: node.kind,
            namespace: node.namespace,
            name: node.name,
            health: node.health?.status,
            message: node.health?.message,
        }));
}
