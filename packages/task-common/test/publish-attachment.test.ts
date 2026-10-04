// The attachment is the one artefact this extension publishes that anyone with build read
// access can download. These tests pin the refusal path -- the e2e tests assert a token is
// ABSENT from a published attachment, which passes trivially if the guard never runs.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';

const warnings: string[] = [];
const attachments: Array<{ type: string; name: string; path: string }> = [];

vi.mock('azure-pipelines-task-lib/task', () => ({
    setSecret: vi.fn(),
    warning: (m: string) => warnings.push(m),
    addAttachment: (type: string, name: string, path: string) => attachments.push({ type, name, path }),
    getVariable: () => os.tmpdir(),
}));

import { RUN_ATTACHMENT_TYPE, type RunAttachment } from '../src/attachment';
import { publishRunAttachment, resetAttachmentSequenceForTesting } from '../src/publish-attachment';
import { registerSecret, resetRegisteredSecretsForTesting } from '../src/secrets';

const base: RunAttachment = { schema: 1, task: 'ArgoCDProject@1', command: 'create-token' };

describe('publishRunAttachment', () => {
    beforeEach(() => {
        warnings.length = 0;
        attachments.length = 0;
        resetRegisteredSecretsForTesting();
        resetAttachmentSequenceForTesting();
    });

    it('publishes a clean payload and writes readable JSON', () => {
        const file = publishRunAttachment({ ...base, notes: ['created token 4f1a'] });
        expect(file).toBeDefined();
        expect(attachments).toHaveLength(1);
        expect(attachments[0]?.type).toBe(RUN_ATTACHMENT_TYPE);
        const written = JSON.parse(fs.readFileSync(file as string, 'utf8')) as RunAttachment;
        expect(written.task).toBe('ArgoCDProject@1');
        expect(written.schema).toBe(1);
    });

    it('REFUSES to publish when a registered secret is in the payload', () => {
        registerSecret('minted-jwt-value');
        const file = publishRunAttachment({ ...base, notes: ['token is minted-jwt-value'] });

        expect(file, 'a payload carrying a secret must not be written').toBeUndefined();
        expect(attachments, 'nothing may be attached').toHaveLength(0);
        expect(warnings.join(' ')).toContain('were not published');
    });

    it('REFUSES on a JWT-shaped value that was never registered', () => {
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG8ifQ.c2ln';
        expect(publishRunAttachment({ ...base, notes: [jwt] })).toBeUndefined();
        expect(attachments).toHaveLength(0);
    });

    it('gives each attachment in a step a unique name', () => {
        // Same name twice in one step silently REPLACES the first -- no error anywhere.
        publishRunAttachment(base);
        publishRunAttachment(base);
        expect(attachments).toHaveLength(2);
        expect(attachments[0]?.name).not.toBe(attachments[1]?.name);
    });

    it('never fails the task, whatever goes wrong', () => {
        // A cyclic object cannot be serialised; the task must still survive it.
        const cyclic = { ...base } as RunAttachment & { self?: unknown };
        cyclic.self = cyclic;
        expect(() => publishRunAttachment(cyclic)).not.toThrow();
        expect(warnings.join(' ')).toContain('Could not publish');
    });
});
