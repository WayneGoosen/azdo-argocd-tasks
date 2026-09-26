// The `delete` command.
//
// This is the only command that destroys something, so it is the only one with guards:
//
//   1. NO SELECTORS. Applications must be named explicitly. A mistyped label selector
//      would otherwise cascade into deleting everything it matched, and a pipeline is a
//      bad place to discover that. Selector-based deletion remains available through
//      ArgoCDCli@1 for anyone who genuinely needs it.
//   2. `confirm: true` is required. The Argo CD API has no confirmation parameter at all
//      -- the CLI's `--yes` prompt is purely client-side -- so this guard is entirely ours.
//   3. `cascade: false` and a propagation policy cannot be combined, because the server
//      rejects that pairing. Catching it here gives a better message than the server's.
//
// Deletion is ASYNCHRONOUS: the call returns once the finalizer is set, and the object
// lingers while the controller reaps its children. The task says so rather than implying
// the resources are already gone.

import * as tl from 'azure-pipelines-task-lib/task';
import { getBoolInputOrDefault } from '@azdo-argocd/task-common';
import { OperationContext, OperationOutcome } from './context';

const VALID_PROPAGATION_POLICIES = ['', 'foreground', 'background'];

export async function runDelete(ctx: OperationContext): Promise<OperationOutcome> {
    if (ctx.common.selector !== undefined) {
        throw new Error(
            'The delete command does not accept a label selector. Name each application explicitly ' +
                'in "applications" instead -- a mistyped selector could otherwise delete every ' +
                'application it matched. Use ArgoCDCli@1 if you genuinely need selector-based deletion.',
        );
    }

    if (ctx.common.applications.length === 0) {
        throw new Error('Name at least one application to delete in "applications".');
    }

    if (!tl.getBoolInput('confirm', false)) {
        const names = ctx.common.applications.map((ref) => ref.name).join(', ');
        throw new Error(
            `Refusing to delete ${ctx.common.applications.length} application(s) (${names}) without ` +
                'confirmation. Set the "confirm" input to true to proceed. This is deliberate: ' +
                'deleting an Argo CD application also deletes the resources it manages.',
        );
    }

    const cascade = getBoolInputOrDefault('cascade', true);
    const propagationPolicy = (tl.getInput('propagationPolicy', false) ?? '').trim().toLowerCase();

    if (!VALID_PROPAGATION_POLICIES.includes(propagationPolicy)) {
        throw new Error(
            `"${propagationPolicy}" is not a valid propagation policy. Use "foreground", "background", ` +
                'or leave it empty for the Argo CD default.',
        );
    }
    if (!cascade && propagationPolicy !== '') {
        throw new Error(
            'A propagation policy cannot be combined with cascade disabled: with cascading off there ' +
                'is nothing to propagate to. Either enable cascade, or clear "propagationPolicy".',
        );
    }

    if (!cascade) {
        console.log(
            'Cascade is disabled: the Application will be removed but the resources it manages will ' +
                'be left running in the cluster.',
        );
    }

    const deleted: string[] = [];
    for (const ref of ctx.common.applications) {
        console.log(`Deleting "${ref.name}"...`);
        await ctx.client.deleteApplication(
            ref.name,
            { cascade, ...(propagationPolicy === '' ? {} : { propagationPolicy }) },
            { appNamespace: ref.appNamespace, project: ctx.common.project },
        );
        deleted.push(ref.name);
    }

    console.log(
        'Deletion has been requested. Argo CD removes applications asynchronously, so the resources ' +
            'may take a while to disappear from the cluster.',
    );

    return {
        decision: {
            verdict: 'succeeded',
            message: `Requested deletion of ${deleted.length} application(s): ${deleted.join(', ')}`,
        },
        // The applications are going away, so a status snapshot would be meaningless here.
        snapshots: [],
        summary: undefined,
        extraOutputs: { deletedCount: String(deleted.length) },
    };
}
