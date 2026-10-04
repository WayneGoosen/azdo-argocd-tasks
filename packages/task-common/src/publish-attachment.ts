// Publishing a run attachment for the "Argo CD" build-results tab.
//
// Kept separate from ./attachment, which is the pure wire contract and MUST stay free of
// azure-pipelines-task-lib: the tab imports that file too, and pulling task-lib into a
// browser bundle would be both broken and enormous.
//
// This is the single choke point where anything we produce becomes publicly downloadable, so
// it is also where the secret check lives. There is deliberately no other way to attach.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tl from 'azure-pipelines-task-lib/task';
import { RUN_ATTACHMENT_TYPE, RUN_SCHEMA_VERSION, type RunAttachment } from './attachment';
import { describeError } from './logging';
import { secretLeakIn } from './secrets';

const OUTPUT_DIRECTORY = 'argocd-tasks';

/**
 * Attachment names must be unique within a step, or a later attachment silently REPLACES an
 * earlier one -- no error, no warning, the first one simply disappears. A counter is enough
 * because attachments are scoped to the timeline record, which is the step.
 */
let sequence = 0;

function attachmentName(run: RunAttachment): string {
    sequence += 1;
    const parts = [run.task.replace(/[^A-Za-z0-9]/g, ''), run.command ?? 'run', String(sequence)];
    return parts.join('-');
}

/**
 * Write the run payload and attach it to the build.
 *
 * Never throws and never fails the task: a missing tab is a cosmetic loss, and a deployment
 * that actually worked must not be reported as failed because of it.
 *
 * Returns the path written, or undefined when nothing was published.
 */
export function publishRunAttachment(run: RunAttachment): string | undefined {
    try {
        const payload = JSON.stringify({ ...run, schema: RUN_SCHEMA_VERSION });

        // Anyone with build read access can download this file, and the agent masks only its
        // own log stream -- not files we write. A hit here is a bug upstream that put a
        // credential somewhere it should never have reached, so refuse outright rather than
        // scrubbing and hiding it.
        const leak = secretLeakIn(payload);
        if (leak !== undefined) {
            tl.warning(
                `The Argo CD results were not published to the build: ${leak}. ` +
                    'This is a bug -- please report it, including the task and command used.',
            );
            return undefined;
        }

        const directory = path.join(tl.getVariable('Agent.TempDirectory') ?? os.tmpdir(), OUTPUT_DIRECTORY);
        fs.mkdirSync(directory, { recursive: true });
        const name = attachmentName(run);
        const filePath = path.join(directory, `${name}.json`);
        fs.writeFileSync(filePath, payload, 'utf8');

        tl.addAttachment(RUN_ATTACHMENT_TYPE, name, filePath);
        console.log('Published these results to the Argo CD tab of this run.');
        return filePath;
    } catch (error) {
        tl.warning(`Could not publish the Argo CD results: ${describeError(error)}`);
        return undefined;
    }
}

/** Test seam only. The sequence is per-process state by design. */
export function resetAttachmentSequenceForTesting(): void {
    sequence = 0;
}
