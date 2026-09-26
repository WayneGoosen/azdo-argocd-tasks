// Task input parsing.
//
// Kept separate from the operations so the operations can be exercised without the
// azure-pipelines-task-lib input plumbing.

import * as tl from 'azure-pipelines-task-lib/task';
import { RefreshType } from '@azdo-argocd/argocd-client';
import { WaitCondition, getBoolInputOrDefault } from '@azdo-argocd/task-common';

export type Command =
    | 'get'
    | 'sync'
    | 'wait'
    | 'diff'
    | 'refresh'
    | 'history'
    | 'rollback'
    | 'action'
    | 'manifests'
    | 'logs'
    | 'terminate'
    | 'create'
    | 'set'
    | 'unset'
    | 'delete';

export interface ApplicationRef {
    name: string;
    appNamespace: string | undefined;
}

export interface CommonInputs {
    command: Command;
    applications: ApplicationRef[];
    selector: string | undefined;
    project: string | undefined;
    appNamespace: string | undefined;
    publishSummary: boolean;
    timeoutSeconds: number;
}

export interface WaitInputs {
    conditions: WaitCondition[];
    timeoutSeconds: number;
    failOnTimeout: boolean;
    pollIntervalSeconds: number;
}

const VALID_COMMANDS: readonly Command[] = [
    'get',
    'sync',
    'wait',
    'diff',
    'refresh',
    'history',
    'rollback',
    'action',
    'manifests',
    'logs',
    'terminate',
    'create',
    'set',
    'unset',
    'delete',
];
const VALID_CONDITIONS: readonly WaitCondition[] = ['sync', 'health', 'operation', 'suspended'];

export function getCommand(): Command {
    const raw = (tl.getInput('command', true) ?? '').trim() as Command;
    if (!VALID_COMMANDS.includes(raw)) {
        throw new Error(`Unknown command "${raw}". Expected one of: ${VALID_COMMANDS.join(', ')}.`);
    }
    return raw;
}

/**
 * Parse the `applications` multiline input.
 *
 * Each line is either `name` or `namespace/name`. A per-line namespace wins over the
 * task-level `appNamespace`, so one step can target apps in several namespaces.
 */
export function parseApplications(raw: string[], defaultNamespace: string | undefined): ApplicationRef[] {
    return raw
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => {
            const separator = line.indexOf('/');
            if (separator === -1) {
                return { name: line, appNamespace: defaultNamespace };
            }
            return {
                name: line.slice(separator + 1).trim(),
                appNamespace: line.slice(0, separator).trim(),
            };
        })
        .filter((ref) => ref.name !== '');
}

export function getCommonInputs(): CommonInputs {
    const appNamespace = emptyToUndefined(tl.getInput('appNamespace', false));
    const applications = parseApplications(tl.getDelimitedInput('applications', '\n', false), appNamespace);
    const selector = emptyToUndefined(tl.getInput('selector', false));

    const command = getCommand();

    // `create` takes its application names from the manifest file, so it is the one
    // command that legitimately runs without a target.
    if (command !== 'create' && applications.length === 0 && selector === undefined) {
        throw new Error(
            'Specify at least one application in "applications", or a label "selector" to match several.',
        );
    }

    return {
        command,
        applications,
        selector,
        project: emptyToUndefined(tl.getInput('project', false)),
        appNamespace,
        publishSummary: getBoolInputOrDefault('publishSummary', true),
        timeoutSeconds: getPositiveInt('timeoutSeconds', 600),
    };
}

/**
 * `waitFor` is a comma-separated condition list, e.g. "sync,health".
 * Unknown entries are rejected rather than ignored -- a typo here would otherwise make
 * the task succeed without waiting for anything.
 */
export function parseConditions(raw: string | undefined): WaitCondition[] {
    const parts = (raw ?? 'sync,health')
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part !== '');

    const conditions = parts.length === 0 ? ['sync', 'health'] : parts;
    for (const condition of conditions) {
        if (!VALID_CONDITIONS.includes(condition as WaitCondition)) {
            throw new Error(
                `Unknown wait condition "${condition}". Expected a comma-separated list of: ${VALID_CONDITIONS.join(', ')}.`,
            );
        }
    }
    return conditions as WaitCondition[];
}

export function getWaitInputs(): WaitInputs {
    return {
        conditions: parseConditions(tl.getInput('waitFor', false)),
        timeoutSeconds: getPositiveInt('timeoutSeconds', 600),
        failOnTimeout: getBoolInputOrDefault('failOnTimeout', true),
        pollIntervalSeconds: getPositiveInt('pollIntervalSeconds', 5),
    };
}

export function getRefreshType(inputName: string): RefreshType | undefined {
    const raw = (tl.getInput(inputName, false) ?? 'none').trim().toLowerCase();
    if (raw === 'hard') {
        return 'hard';
    }
    if (raw === 'normal') {
        return 'normal';
    }
    // Anything else means "do not refresh", which requires OMITTING the parameter --
    // sending it empty still triggers a refresh server-side.
    return undefined;
}

/**
 * Parse `GROUP:KIND:NAME` or `KIND:NAME` resource selectors, one per line.
 * A namespace may be appended as `GROUP:KIND:NAME:NAMESPACE`.
 */
export function parseResources(raw: string[]): Array<{ group?: string; kind: string; name: string; namespace?: string }> {
    return raw
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => {
            const parts = line.split(':').map((part) => part.trim());
            if (parts.length === 2) {
                return { kind: parts[0] as string, name: parts[1] as string };
            }
            if (parts.length === 3) {
                return { group: parts[0] as string, kind: parts[1] as string, name: parts[2] as string };
            }
            if (parts.length === 4) {
                return {
                    group: parts[0] as string,
                    kind: parts[1] as string,
                    name: parts[2] as string,
                    namespace: parts[3] as string,
                };
            }
            throw new Error(
                `Cannot parse resource "${line}". Use KIND:NAME, GROUP:KIND:NAME or GROUP:KIND:NAME:NAMESPACE.`,
            );
        });
}

export function getPositiveInt(name: string, fallback: number): number {
    const raw = tl.getInput(name, false);
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        throw new Error(`Input "${name}" must be a positive whole number, got "${raw}".`);
    }
    return parsed;
}

export function emptyToUndefined(value: string | undefined): string | undefined {
    return value === undefined || value.trim() === '' ? undefined : value.trim();
}
