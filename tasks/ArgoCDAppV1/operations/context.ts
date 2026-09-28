// Shared context and helpers for the ArgoCDApp commands.
//
// Every command needs the same three things: which applications to act on, a snapshot of
// their current state, and -- when something fails -- the unhealthy resources behind it.

import * as tl from 'azure-pipelines-task-lib/task';
import { Application, ArgoCdClient, ResourceNode, revisionOf, revisionsOf } from '@azdo-argocd/argocd-client';
import { AppSnapshot, Decision } from '@azdo-argocd/task-common';
import { ApplicationRef, CommonInputs } from '../inputs';

export interface OperationContext {
    client: ArgoCdClient;
    serverUrl: string;
    common: CommonInputs;
}

export interface OperationOutcome {
    decision: Decision;
    snapshots: AppSnapshot[];
    summary: string | undefined;
    extraOutputs: Record<string, string>;
}

function nonEmpty(values: string[]): string[] | undefined {
    return values.length === 0 ? undefined : values;
}

export function toSnapshot(app: Application, fallbackName: string): AppSnapshot {
    const status = app.status;
    return {
        name: app.metadata?.name ?? fallbackName,
        namespace: app.metadata?.namespace,
        syncStatus: status?.sync?.status,
        healthStatus: status?.health?.status,
        healthMessage: status?.health?.message,
        operationPhase: status?.operationState?.phase,
        operationMessage: status?.operationState?.message,
        revision: revisionOf(status?.operationState?.syncResult) ?? revisionOf(status?.sync),
        revisions: nonEmpty(revisionsOf(status?.operationState?.syncResult)) ?? revisionsOf(status?.sync),
    };
}

/**
 * Resolve which applications to act on.
 *
 * A label selector is resolved once, up front, so every later call targets explicit
 * names. That keeps behaviour stable if apps are created or deleted mid-run, and it makes
 * the summary list match what was actually acted on.
 */
export async function resolveApplications(ctx: OperationContext): Promise<ApplicationRef[]> {
    if (ctx.common.selector === undefined) {
        return ctx.common.applications;
    }

    const list = await ctx.client.listApplications({
        selector: ctx.common.selector,
        appNamespace: ctx.common.appNamespace,
        ...(ctx.common.project === undefined ? {} : { projects: [ctx.common.project] }),
    });

    const refs = (list.items ?? []).map((app) => ({
        name: app.metadata?.name ?? '',
        appNamespace: app.metadata?.namespace,
    }));

    const named = refs.filter((ref) => ref.name !== '');
    if (named.length === 0) {
        throw new Error(
            `No applications matched selector "${ctx.common.selector}". ` +
                'Check the label selector, and that the token can see the project.',
        );
    }
    console.log(`Selector "${ctx.common.selector}" matched ${named.length} application(s).`);
    return named;
}

export async function fetchSnapshots(
    ctx: OperationContext,
    refs: readonly ApplicationRef[],
    refresh?: 'normal' | 'hard',
): Promise<AppSnapshot[]> {
    const snapshots: AppSnapshot[] = [];
    for (const ref of refs) {
        const app = await ctx.client.getApplication(ref.name, {
            appNamespace: ref.appNamespace,
            project: ctx.common.project,
            ...(refresh === undefined ? {} : { refresh }),
        });
        snapshots.push(toSnapshot(app, ref.name));
    }
    return snapshots;
}

/** Collect unhealthy resource nodes so a failure explains itself without a second run. */
export async function fetchUnhealthyNodes(
    ctx: OperationContext,
    refs: readonly ApplicationRef[],
): Promise<ResourceNode[]> {
    const nodes: ResourceNode[] = [];
    for (const ref of refs) {
        try {
            const tree = await ctx.client.getResourceTree(ref.name, {
                appNamespace: ref.appNamespace,
                project: ctx.common.project,
            });
            nodes.push(
                ...(tree.nodes ?? []).filter(
                    (node) => node.health?.status !== undefined && node.health.status !== 'Healthy',
                ),
            );
        } catch (error) {
            // Diagnostics must never turn a pass into a fail.
            tl.debug(`Could not read the resource tree for ${ref.name}: ${String(error)}`);
        }
    }
    return nodes;
}
