// The `set` and `unset` commands -- edit deployment fields on the live Application spec.
//
// A WORD ON WHY THIS IS A FOOTGUN, which the task says out loud at runtime: changing the
// live spec puts the cluster ahead of Git. Argo CD will then either report the application
// OutOfSync indefinitely, or -- with self-heal enabled -- quietly revert the change. The
// durable way to bump an image is to commit it to the GitOps repository and sync.
//
// Implementation note that matters more than it looks: PUT /spec is a FULL REPLACE, so the
// spec is read, MUTATED IN PLACE, and written back whole. Rebuilding it from our narrow
// types would delete every field we do not model.

import * as tl from 'azure-pipelines-task-lib/task';
import {
    OpaqueSpec,
    getBoolInputOrDefault,
    mergeKustomizeImage,
    normalizeSource,
    removeHelmParameter,
    removeHelmValueFile,
    removeKustomizeImage,
    selectSource,
    setHelmValueFiles,
    setTargetRevision,
    upsertHelmParameter,
} from '@azdo-argocd/task-common';
import { getPositiveInt } from '../inputs';
import { OperationContext, OperationOutcome, fetchSnapshots, resolveApplications } from './context';

const DRIFT_WARNING =
    'Changing the live Application spec puts the cluster ahead of Git. Argo CD will report this ' +
    'application OutOfSync until the change is committed, or silently revert it if self-heal is ' +
    'enabled. The durable alternative is to commit the change to your GitOps repository and sync.';

interface EditInputs {
    helmParameters: string[];
    helmStringParameters: string[];
    helmValueFiles: string[];
    kustomizeImages: string[];
    targetRevision: string | undefined;
    sourcePosition: number | undefined;
}

function readEditInputs(): EditInputs {
    const rawPosition = tl.getInput('sourcePosition', false);
    return {
        helmParameters: nonEmptyLines(tl.getDelimitedInput('helmParameters', '\n', false)),
        helmStringParameters: nonEmptyLines(tl.getDelimitedInput('helmStringParameters', '\n', false)),
        helmValueFiles: nonEmptyLines(tl.getDelimitedInput('helmValueFiles', '\n', false)),
        kustomizeImages: nonEmptyLines(tl.getDelimitedInput('kustomizeImages', '\n', false)),
        targetRevision: tl.getInput('targetRevision', false) || undefined,
        sourcePosition:
            rawPosition === undefined || rawPosition.trim() === ''
                ? undefined
                : getPositiveInt('sourcePosition', 1),
    };
}

function nonEmptyLines(lines: string[]): string[] {
    return lines.map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
}

/** Split `name=value`, erroring rather than guessing when there is no `=`. */
export function parseNameValue(line: string): { name: string; value: string } {
    const separator = line.indexOf('=');
    if (separator === -1) {
        throw new Error(`Cannot parse "${line}". Use name=value.`);
    }
    return { name: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() };
}

/** In unset mode the inputs carry NAMES, so a `name=value` line is a mistake worth naming. */
function assertNameOnly(line: string, inputName: string): string {
    if (line.includes('=')) {
        throw new Error(
            `"${line}" looks like name=value, but the unset command takes names only. ` +
                `Pass just "${line.slice(0, line.indexOf('='))}" in "${inputName}".`,
        );
    }
    return line;
}

function describeEdits(inputs: EditInputs): number {
    return (
        inputs.helmParameters.length +
        inputs.helmStringParameters.length +
        inputs.helmValueFiles.length +
        inputs.kustomizeImages.length +
        (inputs.targetRevision === undefined ? 0 : 1)
    );
}

export async function runSpecEdit(ctx: OperationContext, mode: 'set' | 'unset'): Promise<OperationOutcome> {
    const refs = await resolveApplications(ctx);
    const inputs = readEditInputs();
    const validate = getBoolInputOrDefault('validate', true);

    if (describeEdits(inputs) === 0) {
        throw new Error(
            `The ${mode} command needs at least one field to change. Set "helmParameters", ` +
                '"helmStringParameters", "helmValueFiles", "kustomizeImages" or "targetRevision".',
        );
    }

    tl.warning(DRIFT_WARNING);

    for (const ref of refs) {
        const query = { appNamespace: ref.appNamespace, project: ctx.common.project };
        const app = await ctx.client.getApplication(ref.name, query);

        // The runtime object carries every field the server sent, even those our types do
        // not model. Mutating it in place is what keeps them.
        const spec = app.spec as unknown as OpaqueSpec | undefined;
        if (spec === undefined) {
            throw new Error(`Application "${ref.name}" returned no spec.`);
        }

        const source = selectSource(spec, inputs.sourcePosition);
        const changes: string[] = [];

        if (mode === 'set') {
            for (const line of inputs.helmParameters) {
                const { name, value } = parseNameValue(line);
                upsertHelmParameter(source, { name, value });
                changes.push(`helm parameter ${name}=${value}`);
            }
            for (const line of inputs.helmStringParameters) {
                const { name, value } = parseNameValue(line);
                upsertHelmParameter(source, { name, value, forceString: true });
                changes.push(`helm string parameter ${name}=${value}`);
            }
            if (inputs.helmValueFiles.length > 0) {
                // Whole-array replace, matching `argocd app set --values`.
                setHelmValueFiles(source, inputs.helmValueFiles);
                changes.push(`helm value files = [${inputs.helmValueFiles.join(', ')}]`);
            }
            for (const image of inputs.kustomizeImages) {
                mergeKustomizeImage(source, image);
                changes.push(`kustomize image ${image}`);
            }
            if (inputs.targetRevision !== undefined) {
                setTargetRevision(source, inputs.targetRevision);
                changes.push(`target revision ${inputs.targetRevision}`);
            }
        } else {
            for (const line of [...inputs.helmParameters, ...inputs.helmStringParameters]) {
                const name = assertNameOnly(line, 'helmParameters');
                changes.push(
                    removeHelmParameter(source, name)
                        ? `removed helm parameter ${name}`
                        : `helm parameter ${name} was not set`,
                );
            }
            for (const file of inputs.helmValueFiles) {
                changes.push(
                    removeHelmValueFile(source, file)
                        ? `removed helm value file ${file}`
                        : `helm value file ${file} was not set`,
                );
            }
            for (const line of inputs.kustomizeImages) {
                const image = assertNameOnly(line, 'kustomizeImages');
                changes.push(
                    removeKustomizeImage(source, image)
                        ? `removed kustomize image ${image}`
                        : `kustomize image ${image} was not set`,
                );
            }
            if (inputs.targetRevision !== undefined) {
                throw new Error('"targetRevision" cannot be unset. Use the set command to change it.');
            }
        }

        // An emptied helm/kustomize block would otherwise read back differently from what
        // was written, which looks like drift on the next diff.
        normalizeSource(source);

        console.log(`${ref.name}:`);
        for (const change of changes) {
            console.log(`  ${change}`);
        }

        await ctx.client.updateApplicationSpec(ref.name, spec, { validate }, query);
        console.log(`  spec updated`);
    }

    const snapshots = await fetchSnapshots(ctx, refs);
    return {
        decision: {
            verdict: 'succeeded',
            message: `Updated the spec of ${refs.length} application(s)`,
        },
        snapshots,
        summary: undefined,
        extraOutputs: {},
    };
}
