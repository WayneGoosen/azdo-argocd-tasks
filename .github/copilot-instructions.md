# azdo-argocd-tasks

Azure DevOps extension in TypeScript, packaged with `tfx-cli`. Six pipeline
tasks talk to the Argo CD REST API; a build-results tab renders their
attachments. Read `STATUS.md` and `.github/RELEASING.md` before changing
release, versioning, or Marketplace behaviour.

Coding agents: run the checks in `AGENTS.md` before opening a PR and paste
the output into the Testing section of the PR template.

## How to review

Modelled on Anthropic's `REVIEW.md` approach. Keep it short.

1. **Start the summary with a count** of findings by severity:

   `Important: N · Nit: N · Pre-existing: N`

   If there are no Important findings, lead with **No blocking issues.**
2. **Correctness and security beat style.** CI already runs typecheck, lint,
   tests, and packaging. Do not re-litigate formatting, naming, or anything
   ESLint/`tsc` already enforce.
3. **Every finding needs evidence:** a file path and line in the *changed*
   code, plus what a real failure would look like. No citation, no finding.
4. **Label every finding** `Important`, `Nit`, or `Pre-existing`.
5. **Cap nits at three**, clearly labelled. If there are more, write
   `plus N similar items` in the summary instead of posting them.
6. **Skip generated and vendored paths:** `dist/`, `vendor/`, `coverage/`,
   `site/`, `.dev/`, `node_modules/`, lockfiles, `docs/assets/images/`,
   `*.vsix`, and other build output.

### Severity in this repo

| Label | Use it for |
|---|---|
| **Important** | A change that would ship a broken or unsafe task, tab, or workflow: dropped promises, XSS in the tab, leaked secrets, a Marketplace version you cannot replace, a task-major bump in place, a Node 20 handler silently untested, an unpinned action on a workflow that holds `ADO_PUBLISHER_PAT`, a missing defensive guard on an Argo CD response that can omit a field. |
| **Nit** | Style, naming, optional refactors, comments. Never blocking. |
| **Pre-existing** | A real bug that is already on `main` and was not introduced by this PR. Do not demand it be fixed here. |

## What a real failure looks like here

These are load-bearing. A review that misses one of them has failed.

- **Floating promise.** Every task entry is `async run()` ending in `void run()`.
  A dropped rejection means the agent reports success for a step that threw.
  `@typescript-eslint/no-floating-promises` is the reason ESLint exists in
  this repo.
- **`innerHTML` in the tab.** The tab runs under a host CSP and renders
  cluster data. `innerHTML` / `outerHTML` / `document.write` turn an
  application name or a diff line into XSS. Build nodes with
  `createElement` / `textContent` only.
- **Unpinned Actions.** A tag (`@v4`, even `@v4.4.0`) can be moved. Pin
  every `uses:` to a full commit SHA with the version as a trailing
  comment. Workflows that see `ADO_PUBLISHER_PAT` run whatever that SHA
  is. Dependabot already rewrites pins.
- **Immutable Marketplace versions.** Once `1.0.6` is published it can
  never be replaced, only superseded. A bad publish is a new patch, not a
  re-upload. Never list `marketplace/` in `vss-extension.json` `files[]` —
  tfx silently drops `Content.Details` and screenshots, and the listing
  ships blank on a version you cannot fix.
- **Task major is the public reference.** `ArgoCDApp@1` is a different
  task from `ArgoCDApp@2`. `scripts/stamp-version.mjs` refuses to change a
  declared major. A breaking change needs a new `tasks/ArgoCDAppV2/`
  directory shipped *alongside* V1, not an edit in place.
- **CI and the task handler stay on Node 20.** `task.json` declares
  `Node20_1` and `Node24`; esbuild targets `node20`. CI uses Node 20
  because `test/support/run-task.ts` spawns the bundle with
  `process.execPath` — that *is* how `Node20_1` is validated. Bumping CI
  to 22+ quietly stops testing the oldest agent runtime we ship.
- **No secrets in fixtures or tests.** Tokens, PATs, and real server URLs
  do not belong in `test/`, `dev-fixtures/`, or samples. Use obvious
  fakes. Secrets go through `registerSecret`, never `tl.setSecret`
  directly, or the run-attachment guard cannot see them.
- **Argo CD responses are optimistic types.** Swagger says a field is
  present; the server can omit it. Keep the defensive guards. Do not
  "fix" them because `no-unnecessary-condition` would call them dead —
  that rule is off on purpose. `PUT /applications/{name}/spec` is a full
  replace: mutate the parsed object in place, never reconstruct a spec
  from typed fields.

## Do not "tidy"

These look like mistakes. They are not.

- esbuild for tasks, **webpack for the tab** (`azure-devops-extension-api`
  is AMD-only). One bundler silently blanks the tab.
- `trimSlashes()`, never `replace(/\/+$/, '')` (polynomial; CodeQL flags it).
- `Array<T>` and bracket index access are deliberate; the stylistic ESLint
  sets are not enabled.
- `await` on `SDK.getService()` results even when the `.d.ts` says they
  are sync. XDM proxies always return a Promise. Removing the await
  shipped a blank tab in 1.0.15.
- Endpoint type is `argocdrest`, not `argocd`. The latter is taken
  Marketplace-wide.
- Two copies of `azure-pipelines-task-lib` or `azure-devops-extension-sdk`
  split module state / hang the tab with no error.
