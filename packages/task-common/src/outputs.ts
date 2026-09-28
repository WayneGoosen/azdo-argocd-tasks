// Output variables.
//
// `outputVariables` in task.json is metadata for the pipeline editor only -- it does not
// emit anything. The value is set at runtime with isOutput = true, which writes
// ##vso[task.setvariable variable=<name>;isOutput=true].

import * as tl from 'azure-pipelines-task-lib/task';

// Names are camelCase, NOT the SCREAMING_SNAKE the PRD sketched: task.json's
// `outputVariables[].name` is constrained to ^[A-Za-z][A-Za-z0-9]*$, so an underscore
// cannot be declared at all. Pipelines reference these as $(stepName.syncStatus).
export const OutputNames = {
    SYNC_STATUS: 'syncStatus',
    HEALTH_STATUS: 'healthStatus',
    REVISION: 'revision',
    REVISIONS: 'revisions',
    OPERATION_PHASE: 'operationPhase',
    OPERATION_MESSAGE: 'operationMessage',
    APP_URL: 'appUrl',
    APPS_JSON: 'appsJson',
    HAS_DIFF: 'hasDiff',
    DIFF_RESOURCE_COUNT: 'diffResourceCount',
} as const;

export function setOutput(name: string, value: string, isSecret = false): void {
    tl.setVariable(name, value, isSecret, true);
}

// applicationUrl lives in urls.ts so it can be used without loading task-lib.
export { applicationUrl } from './urls';

/**
 * Read a boolean input, honouring a declared default of `true`.
 *
 * tl.getBoolInput returns false for an absent input, so any input whose task.json default
 * is "true" would silently invert if the value never arrives. The agent normally supplies
 * declared defaults, but relying on that makes the task wrong when driven directly, and
 * leaves a safety-relevant default (fail on error, verify checksums) depending on the
 * caller rather than on the task.
 */
export function getBoolInputOrDefault(name: string, fallback: boolean): boolean {
    const raw = tl.getInput(name, false);
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    return raw.trim().toLowerCase() === 'true';
}
