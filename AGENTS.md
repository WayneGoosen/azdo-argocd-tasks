# Agent instructions

This is an Azure DevOps Marketplace extension (`tfx-cli`, TypeScript).
Repo rules live in `.github/copilot-instructions.md`. Path-specific
review notes are under `.github/instructions/`.

Do **not** push to `main`. Marketplace versions are immutable: a published
version cannot be replaced, so a bad release is a new patch, not a
re-upload.

## Before opening a pull request

Run the same checks as `.github/workflows/pr.yml` and **paste their
output** into the Testing section of `.github/pull_request_template.md`.

```sh
npm ci
npm run typecheck
npm run typecheck:tab
npm run lint
npm run test:coverage
npm run package
```

Do not stamp versions locally. CI runs GitVersion and
`scripts/stamp-version.mjs`. Do not bump a task `version.Major` in
place — that needs a new `tasks/*V2/` directory.

Stay on Node 20 for anything that claims to match CI. `.nvmrc` is `20`;
`test/support/run-task.ts` spawns the bundled tasks with
`process.execPath`, which is how the `Node20_1` handler is validated.
