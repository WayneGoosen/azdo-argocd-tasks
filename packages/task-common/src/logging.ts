// Logging helpers.
//
// Collapsible groups keep a multi-application run readable: one group per application
// rather than a flat wall of poll lines.

import * as tl from 'azure-pipelines-task-lib/task';

export function beginGroup(name: string): void {
    console.log(`##[group]${name}`);
}

export function endGroup(): void {
    console.log('##[endgroup]');
}

export async function withGroup<T>(name: string, body: () => Promise<T>): Promise<T> {
    beginGroup(name);
    try {
        return await body();
    } finally {
        endGroup();
    }
}

/**
 * Publish a Markdown summary tab on the pipeline run.
 *
 * The content must be written to a file first; the logging command only takes a path.
 * Failures here are warnings, never task failures -- a missing summary must not fail a
 * deployment that actually succeeded.
 */
export function uploadSummary(filePath: string, title: string): void {
    try {
        console.log(`##vso[task.uploadsummary]${filePath}`);
    } catch (error) {
        tl.warning(`Could not publish the "${title}" summary: ${describeError(error)}`);
    }
}

export function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
