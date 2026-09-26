// The `action` command -- run a resource action such as `restart` on a Deployment.
//
// With no action name supplied, this LISTS what is available rather than failing. Action
// names are defined by Argo CD's Lua action library and by per-resource overrides, so
// "what can I even run here?" is a question the task should answer rather than punt.
//
// Two things to know about running one:
//   * Parameters are name/value STRINGS only. The API exposes a parameter's name and
//     nothing else -- no type, no default -- so values cannot be validated up front.
//   * The action is NOT transactional. It runs a Lua script that may create and patch
//     several resources; a failure partway through leaves earlier changes applied.

import * as tl from 'azure-pipelines-task-lib/task';
import { ResourceRef } from '@azdo-argocd/argocd-client';
import { parseResources } from '../inputs';
import { OperationContext, OperationOutcome, fetchSnapshots, resolveApplications } from './context';

/** Parse `name=value` lines. Values may contain `=`; only the first one splits. */
export function parseActionParameters(lines: readonly string[]): Array<{ name: string; value: string }> {
    return lines
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => {
            const separator = line.indexOf('=');
            if (separator === -1) {
                throw new Error(`Cannot parse action parameter "${line}". Use name=value.`);
            }
            return {
                name: line.slice(0, separator).trim(),
                value: line.slice(separator + 1).trim(),
            };
        });
}

/** The single resource an action targets, from the shared GROUP:KIND:NAME[:NAMESPACE] form. */
export function readTargetResource(): ResourceRef {
    const parsed = parseResources(tl.getDelimitedInput('resource', '\n', false));
    if (parsed.length === 0) {
        throw new Error(
            'The "resource" input is required for this command. Use KIND:NAME, GROUP:KIND:NAME ' +
                'or GROUP:KIND:NAME:NAMESPACE, for example apps:Deployment:payments-api.',
        );
    }
    if (parsed.length > 1) {
        throw new Error('Specify exactly one resource; this command acts on a single resource.');
    }
    return parsed[0] as ResourceRef;
}

export async function runAction(ctx: OperationContext): Promise<OperationOutcome> {
    const refs = await resolveApplications(ctx);
    if (refs.length !== 1) {
        throw new Error(
            `Resource actions target a single application, but ${refs.length} were selected. ` +
                'Name one application rather than using a selector.',
        );
    }

    const ref = refs[0] as { name: string; appNamespace: string | undefined };
    const resource = readTargetResource();
    const actionName = (tl.getInput('action', false) ?? '').trim();
    const query = { appNamespace: ref.appNamespace, project: ctx.common.project };

    if (actionName === '') {
        const available = await ctx.client.listResourceActions(ref.name, resource, query);
        const actions = available.actions ?? [];

        if (actions.length === 0) {
            console.log('This resource offers no actions.');
        } else {
            console.log(`Available actions for ${resource.kind}/${resource.name}:`);
            for (const action of actions) {
                const params = (action.params ?? []).map((p) => p.name).filter(Boolean);
                const suffix = params.length > 0 ? ` (parameters: ${params.join(', ')})` : '';
                console.log(`  ${action.name}${action.disabled === true ? ' [disabled]' : ''}${suffix}`);
            }
        }

        const snapshots = await fetchSnapshots(ctx, refs);
        return {
            decision: {
                verdict: 'succeeded',
                message: `${actions.length} action(s) available on ${resource.kind}/${resource.name}`,
            },
            snapshots,
            summary: undefined,
            extraOutputs: { availableActions: actions.map((a) => a.name ?? '').filter(Boolean).join(',') },
        };
    }

    const parameters = parseActionParameters(tl.getDelimitedInput('actionParameters', '\n', false));
    console.log(`Running "${actionName}" on ${resource.kind}/${resource.name}...`);

    await ctx.client.runResourceAction(ref.name, { action: actionName, parameters, resource }, query);

    // The API returns an empty body, so there is nothing to report but the fact it ran.
    console.log('Action accepted by Argo CD.');
    const snapshots = await fetchSnapshots(ctx, refs);

    return {
        decision: {
            verdict: 'succeeded',
            message: `Ran "${actionName}" on ${resource.kind}/${resource.name}`,
        },
        snapshots,
        summary: undefined,
        extraOutputs: {},
    };
}
