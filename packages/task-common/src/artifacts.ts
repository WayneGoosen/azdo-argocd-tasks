// Writing command output to a file and publishing it as a pipeline artifact.
//
// `manifests` and `logs` can produce a great deal of text. Putting it all in the run log
// makes the log unusable and is capped by the agent anyway, so the full output goes to a
// file that is published as an artifact, and only a bounded tail is echoed.
//
// Note `artifact.upload` is NOT permitted in restricted command mode -- the same
// constraint that keeps ArgoCDApp@1 out of restricted mode for its run summary.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tl from 'azure-pipelines-task-lib/task';
import { describeError } from './logging';

const OUTPUT_DIRECTORY = 'argocd-tasks';

/** Write content to a file under the agent temp directory and return its path. */
export function writeOutputFile(fileName: string, content: string): string {
    const directory = path.join(tl.getVariable('Agent.TempDirectory') ?? os.tmpdir(), OUTPUT_DIRECTORY);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, fileName);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

/**
 * Publish a file as a build artifact.
 * Failures are warnings: a missing artifact must never fail a deployment that worked.
 */
export function uploadArtifact(filePath: string, artifactName: string): void {
    try {
        console.log(
            `##vso[artifact.upload containerfolder=${artifactName};artifactname=${artifactName}]${filePath}`,
        );
    } catch (error) {
        tl.warning(`Could not publish the "${artifactName}" artifact: ${describeError(error)}`);
    }
}

/** Echo at most `maxLines` of text, saying how much was withheld. */
export function echoBounded(content: string, maxLines: number, filePath: string): void {
    const lines = content.split('\n');
    if (lines.length <= maxLines) {
        console.log(content);
        return;
    }
    console.log(lines.slice(0, maxLines).join('\n'));
    console.log(
        `... ${lines.length - maxLines} more line(s) withheld. The full output is in the published artifact (${path.basename(filePath)}).`,
    );
}

/** Filesystem-safe fragment for building an output file name. */
export function safeFileName(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]/g, '-');
}
