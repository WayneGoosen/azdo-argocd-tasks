---
project: azdo-argocd-tasks
domain: waynegoosen
status: In development
priority: P2
stage: pre-release
updated: 2026-09-30
repo: https://github.com/WayneGoosen/azdo-argocd-tasks.git
---

# Argo CD Pipeline Tasks — Status

**One-liner:** Azure Pipelines tasks for Argo CD that call the REST API directly — no CLI download, no gRPC.

The single source of truth for this project: where it is, what is next, what is blocked, and the
things that will bite you. Written so it can be picked up cold.

## 🎯 Now — active focus

**Shipped and green.** `WayneGoosen.argocd-pipeline-tasks` **v1.0.6** is live since 2026-09-28
21:44 UTC. Verified from the published VSIX: the multi-source `revision` fix is in, the
`revisions` output is declared, endpoint type `argocdrest`. The integration matrix is green.
Nothing is blocked; what remains is polish.

- [ ] **Finish and ship the Argo CD tab** (in progress, uncommitted). A real
      `ms.vss-build-web.build-results-tab` named "Argo CD", mirroring `azdo-tf-plan-viewer`:
      webpack bundle (esbuild **cannot** be used -- `azure-devops-extension-api` is AMD-only),
      `tl.addAttachment` on the task side, `BuildRestClient` on the tab side. Scaffolded,
      packaging verified, 528 tests green. `diff`, `history`, `status` and `wait` now populate
      `OperationOutcome.attachment`, so the tab's diff, history and unhealthy sections are
      real rather than fixture-only. Remaining: publish attachments from `AppSet`, `Project`
      and `Account` (their GUIDs are deliberately **not** in `supportsTasks` until they do,
      or the tab appears saying "No Argo CD results"); docs.
      **Release note:** adding `scopes: ["vso.build"]` means every existing install needs
      re-authorisation by an org admin, so this is a minor bump, not a patch.
- [ ] **Capture screenshots** into `marketplace/images/` and declare them in
      `vss-extension.json`. The published 1.0.6 still has **no** `Screenshots.N` asset, so the
      listing renders imageless. This is now the single biggest gap for anyone landing on it
      cold. `.github/RELEASING.md` has the shot list and the JSON snippet.
- [ ] **Recreate the Argo CD service connection** in the test org, and confirm `revision` is
      populated on the real multi-source app that surfaced the bug. The fix is verified by
      tests and by inspecting the published bundle, never against that actual application.

## ⏭️ Next — committed pipeline

- [ ] **Make the run summary tab first-class** — see the backlog entry. It is the most valuable
      undiscovered feature in the extension.
- [ ] **Decide on `internal/prd.md`.** Still gitignored and single-machine.

## 💡 Later — backlog

- **Make the run summary tab first-class.** `ArgoCDApp@1` already publishes a Markdown summary
  (application table, sync/health icons, rendered diff) via `##vso[task.uploadsummary]`, but it is
  undiscoverable and badly presented:
  - **The tab is named after the file**, so it shows as `argocd-sync-1759012345678`
    (`tasks/ArgoCDAppV1/index.ts:155`). `uploadSummary(file, title)` in
    `packages/task-common/src/logging.ts:32` *takes* a title and never uses it — the parameter is
    dead except in the error path. Fix: emit
    `##vso[task.addattachment type=Distributedtask.Core.Summary;name=Argo CD;]<path>`, which sets
    the displayed name explicitly.
  - **Only `ArgoCDApp@1` publishes one.** `ArgoCDAppSet@1` (generated applications),
    `ArgoCDProject@1` (roles and tokens) and `ArgoCDInstall@1` (resolved version, cache hit) all
    have something worth showing.
  - **Make the content much richer** — per-application links into the Argo CD UI, operation
    timings, what changed since the previous revision, resource-level health breakdown.
  - Worth documenting too: nothing in `docs/` currently mentions the summary exists.

- **Phase 4**: `ArgoCDCluster@1`, `ArgoCDRepo@1` (repocreds, certificates, GPG keys), Argo Rollouts,
  `patch-resource`. Least validated demand in the PRD — worth waiting for a user to ask.
- **Drop the `Node20_1` handler** from every `task.json` before April 2027.
- Project role / policy / sync-window editing, and Dex token exchange as a supported auth mode —
  both declined for now, see [Deferred](#deferred-with-reasons).

## ✅ Recently shipped

- **PRD Phases 1–3 complete** — six tasks, 456 tests, a 556 KiB VSIX.
  - `ArgoCDApp@1` — 15 commands: get, sync, wait, diff, refresh, history, rollback, action,
    manifests, logs, terminate, create, set, unset, delete.
  - `ArgoCDAppSet@1` — list, get, create, generate (preview), delete.
  - `ArgoCDProject@1` / `ArgoCDAccount@1` — token minting, revocation, `can-i`.
  - `ArgoCDInstall@1` / `ArgoCDCli@1` — CLI installer and escape hatch.
- Material for MkDocs site in `docs/`, deployed by `pages.yml`.
- Token rotation runbook and sample pipeline.
- Dex token-exchange research spike: **GO, pending one live test**.

## ⚠️ Blockers / open questions

| | |
|---|---|
| **No screenshots** | The listing renders without images until `marketplace/images/` has some. Shot list in `.github/RELEASING.md`. The only user-visible gap. |
| **Fix unconfirmed in the wild** | The multi-source `revision` fix is proven by tests and by inspecting the published bundle, but never run against the real chart-plus-values app that surfaced it. |
| **`internal/prd.md` is gitignored** | The original architecture research exists only on this machine. Move it somewhere tracked if it should survive. |

Publisher verification turned out **not** to be a blocker: the extension listed publicly and
came back `validated, public` without it. The earlier note claiming otherwise was wrong.

### Dated commitments

| When | What | Action |
|---|---|---|
| **3 Nov 2026** | Argo CD 3.6 GA; 3.3 rolls off support | Bump `integration.yml` to 3.4/3.5/3.6, re-vendor via `scripts/fetch-swagger.mjs` |
| **1 Dec 2026** | Global PATs decommissioned | `marketplace-publish.yml` stops working — migrate to workload identity (`.github/RELEASING.md`) |
| **Apr 2027** | Node 20 removed from agents | Drop the `Node20_1` handler |
| **1 Jul 2027** | Azure DevOps `vstoken` issuer retires | Only matters if Dex token exchange is adopted |

## 🪤 Gotchas

Non-obvious facts that cost real time to find. All verified against the Argo CD source.

- **int64 body fields are JSON numbers, not strings.** Argo CD's REST gateway marshals with stdlib
  `encoding/json` (`util/grpc/json.go`), **not protojson**, so `"5"` fails to unmarshal for an
  int64. This shipped as a bug in `rollback` and was caught by reading the marshaler.
  Guarded by `packages/argocd-client/test/int64-encoding.test.ts`. Query parameters are unaffected.
- **`PUT /applications/{name}/spec` is a full replace.** Any field omitted is deleted. Never
  reconstruct a spec from typed fields — mutate the parsed object in place. The narrow TS types are
  a compile-time view only; `JSON.parse` keeps everything. See
  `packages/task-common/src/spec-mutation.ts` and its no-field-loss test.
- **Multi-source applications report `revisions[]`, not `revision`.** Argo CD fills `revision`
  for a single-source app and `revisions` for a multi-source one, leaving the other **present and
  empty** — on `status.sync`, on `operationState.syncResult` and on every `status.history[]` entry.
  Because the empty string is present rather than missing, `a?.revision ?? b?.revision` never falls
  through. This shipped: every multi-source app published an empty `revision` output and a blank
  summary column, silently. Use `revisionOf()` from the client package; guarded by
  `packages/argocd-client/test/multi-source-revision.test.ts` and an e2e test on the real bundle.
  Note the entries are not homogeneous: a Helm chart source reports a **chart version**, so the
  common chart-plus-values-repo app yields `["1.2.3", "<sha>"]`. Hence the separate `revisions`
  output — joined into one string they cannot be told apart.
- **A step with no `name` still gets a reference name — a generated one.** Azure DevOps assigns
  `ArgoCDApp1`, `ArgoCDApp2`, … so output variables exist as `ARGOCDAPP1_HEALTHSTATUS` and
  `$(argocd.healthStatus)` resolves to nothing with no warning. `env | grep -i argocd` in the next
  step is the fastest diagnosis.
- **`str.replace(/\/+$/, '')` is polynomial.** `/+` is greedy with no possessive form in
  JavaScript, so when the `$` anchor fails the engine retries the run from every later
  position: O(n^2). Measured 168ms / 659ms / 2,618ms for 20k / 40k / 80k slashes. It appeared
  in six places and CodeQL flagged every one. Use `trimSlashes()` from
  `@azdo-argocd/argocd-client`, which is two loops and linear. Inputs here are
  pipeline-author controlled rather than attacker controlled, so this was a self-inflicted
  hang at worst -- but it is free to avoid and reads better.
- **`azure-devops-extension-api` ships only AMD modules.** esbuild cannot consume AMD at all,
  which is why the tab alone is bundled by webpack while every task uses esbuild. Not a
  preference -- see the comment at the top of `webpack.config.js`.
- **Two SDK copies hang the tab with no error.** The api package's AMD modules resolve
  `azure-devops-extension-sdk` through the package `exports` map, which can land on a
  different file than our ESM import. Two instances means the second trips the SDK's
  "already loaded" guard and `SDK.init()` never resolves -- the tab sits on its loading state
  forever with nothing logged. The `azure-devops-extension-sdk$` webpack alias prevents it.
- **`tslib` is a real runtime dependency of the SDK's AMD output**, not vestigial. Without it
  the tab bundle fails to resolve at build time.
- **`dist/tab` must be `addressable: true`** or the files ship inside the VSIX with no URL and
  the iframe 404s to a blank tab.
- **`supportsTasks` GUIDs are hand-copied from each `task.json`.** Drift silently stops the tab
  appearing, with no error anywhere. Guarded by `test/manifest/extension-manifest.test.ts`.
- **timelineId and recordId exist only inside the attachment href.** `getAttachments()` returns
  a name and `_links`; `getAttachment()` demands both ids. They have to be regexed out, and
  both the `dev.azure.com` and `*.visualstudio.com` URL shapes must parse.
- **`tl.setSecret` does not protect files we write.** It masks the agent's log stream only. The
  run attachment is `fs.writeFileSync` plus an upload, so secrets are caught by
  `registerSecret`/`secretLeakIn` at the `publishRunAttachment` choke point, which refuses to
  publish rather than scrubbing -- a hit means a bug, and scrubbing would hide it.
- **Service endpoint type names are a Marketplace-GLOBAL namespace.** Not per-publisher, not
  per-extension. The first extension to publish a given name holds it, and every later
  extension declaring it is rejected at validation:
  `The Service Endpoint Contribution ...ServiceEndpointName.ARGOCD with Name ARGOCD already
  exists`. This killed the 1.0.4 publish. **`argocd` is held by `scb-tomasmortensen.vsix-argocd`**
  ("Argo CD Extension", v0.1.0, published 2020-10-09, never updated, ~710 installs). It is not
  reclaimable, so ours is `argocdrest`. The name is invisible to users — they only ever see
  `displayName` and their own connection's name. The dev build derives its own
  (`argocdrestdev`) in `scripts/dev-overrides.mjs`, because a dev build holding the name would
  block production just as effectively. Renaming after publishing would orphan every user's
  existing service connection.
- **The public gallery text search does not find that extension.** Querying
  `extensionquery` with `filterType: 10` (search text) for "argocd" returns zero results, which
  led to a wrong diagnosis of who held the name. Direct lookup by `filterType: 7`
  (`scb-tomasmortensen.vsix-argocd`) finds it immediately. **Never conclude a Marketplace name
  is free from a text search.**
- **`azuredevops_serviceendpoint_argocd` in the Terraform provider is not ours.** It sets
  `Type = "argocd"` for that 2020 extension. Users of this extension need
  `azuredevops_serviceendpoint_generic_v2` (provider >= 1.12.0) with `type = "argocdrest"`.
- **The endpoint name lives in two places that must agree**: `properties.name` on the
  contribution, and `connectedService:<name>` in every `task.json`. A mismatch is not an error
  anywhere — the connection picker just comes up empty. Guarded by
  `test/manifest/extension-manifest.test.ts`.
- **`restricted` command mode blocks `prependpath` and `uploadsummary`.** Only `ArgoCDCli@1` can use
  it. `settableVariables` is a separate check and is safe on every task.
- **`task.json` input and output names cannot contain underscores** — the schema pattern is
  `^[A-Za-z][A-Za-z0-9]*$`. Hence camelCase outputs, not the PRD's `SCREAMING_SNAKE`.
- **`task.json` defaults are applied by the agent, not task-lib.** `getBoolInput` returns `false`
  for an absent input, so a declared `true` default silently inverts. Use `getBoolInputOrDefault`.
- **Always send `project`.** Without it Argo CD returns `permission denied` for both a missing
  application and an RBAC failure, by deliberate anti-enumeration design.
- **The Argo CD server's CLI download route is Linux-only**, and only for the server's own
  architecture. The widely-repeated `{server}/download/argocd-{platform}-{arch}` is wrong.
- **ApplicationSet `create` takes a bare body; `generate` takes it wrapped** as
  `{"applicationSet": …}`. The inconsistency is upstream's — do not "tidy" it.
- **Deleting an ApplicationSet deletes every Application it generated** unless
  `preserveResourcesOnDeletion` is set.
- **Project token deletion returns HTTP 200 even when it deleted nothing.** Verify by re-reading.
- **`it.each(...)` arguments are evaluated at COLLECTION, before any `beforeAll`.** The
  bundle-hygiene suite generated its cases from `dist/`, built in its own `beforeAll` — which
  runs too late. On a clean checkout the list came back empty, `it.each([])` registered **zero
  tests**, and the file *passed*. The suite that guards against dependency leakage could vanish
  from a run with CI still green. Fixed with a vitest `globalSetup` that builds once before
  collection, plus a `generated a case for every task` assertion on the collection-time
  snapshot. That assertion has to read the captured list, not re-read `dist/`: `beforeAll`
  repairs the directory before any test body runs, so a fresh read looks healthy while the
  generated cases are already gone.
- **`npm test` builds its own fixtures, and parallel workers raced to do it.** Several e2e files
  each called `ensureBuilt()`, so on a clean checkout one worker could spawn a bundle another
  was midway through writing — surfacing as a task with completely empty stdout, only in CI.
  Same `globalSetup` fix. Locally it never reproduced because `dist/` was already fresh.
- **Barrel exports leak dependencies into every bundle.** Adding a YAML module to task-common's
  barrel pulled js-yaml into four tasks that never parse YAML. The packages are marked
  `sideEffects: false`; `test/manifest/bundle-hygiene.test.ts` guards it.
- **`tsconfig.json` include depth matters.** `tasks/*/*.ts` silently excluded a new subdirectory
  from typechecking, hiding three real type errors. It is now `tasks/**/*.ts`.

## 🚫 Deferred, with reasons

Considered and declined. The reasoning is the expensive part to reconstruct.

**No `image` command on `ArgoCDApp@1`.** It would either duplicate `set` with `kustomizeImages`
exactly, or guess the source type to pick between a Kustomize image and a Helm parameter. Guessing
is the worse failure: silently writing the wrong spec field looks like success.

**Project role, policy and sync-window editing.** No dedicated endpoints — each is a whole-project
read-modify-write `PUT` with no optimistic concurrency and no server-side conflict retry. Worse,
`Create` with `upsert: true` is a **destructive full-spec replace** that silently wipes roles not
included in the body. These are admin-setup operations, not pipeline operations.

**Dex token exchange as a supported auth mode.** Research says GO pending one live test
(`docs/dex-token-exchange.md`). The blocker is not technical: the `vstoken.dev.azure.com` issuer
retires 1 Jul 2027, and when it flips to Entra **both the connector issuer and the `sub` format
change** — Entra uses an immutable GUID, not `sc://org/project/connection` — silently invalidating
every `policy.csv` line written against it.

**Application-name pickers on the service connection.** Data sources cap responses at 2 MB, and the
API ignores the `fields` parameter, so `GET /api/v1/applications` returns full objects. On a large
instance that blows the cap and the picker breaks silently.

**Proxy support in the REST client.** `node:https` has no native proxy support; HTTPS needs manual
`CONNECT` tunnelling. The transport is an injectable seam
(`packages/argocd-client/src/transport.ts`), so this is additive. `ArgoCDInstall@1`'s GitHub
downloads already go through `tool-lib`, which *does* honour agent proxy config.

**Automating the service-connection update in token rotation.** A second API surface with its own
auth. A half-tested credential-rotation task is worse than the documented step in
`docs/token-rotation.md`.

## Where things live

| | |
|---|---|
| `docs/` | The published MkDocs site. **Tracked** — anything added here goes public. |
| `internal/` | **Gitignored.** `todo.md` (phase-by-phase reviews), `lessons.md`, `prd.md` (the original architecture research that defines the phases). |
| `.github/RELEASING.md` | Release and publishing runbook. |
| `scripts/` | Build, version stamping, swagger vendoring, the kind harness, icon generation. |

## Health

- **Last commit:** 2026-09-28 `ab2c560` — releases tagged through `v1.0.6`; working tree clean,
  nothing unpushed
- **Visibility:** repo public; Pages live at <https://waynegoosen.github.io/azdo-argocd-tasks/>
  (redirects to the account's `waynegoosen.com` custom domain)
- **Marketplace:** **v1.0.6 live** (validated, public, 2 installs). 1.0.4 was rejected for the
  endpoint-name collision; 1.0.0-1.0.6 are spent and can never be reused
- **Tests:** 516 passing, 28 integration skipped (no live server). Deterministic from a clean
  tree — verified by repeated `rm -rf dist && npm test`
- **Build:** 6 task bundles, each self-contained, 576 KiB VSIX
- **CI:** Main, Docs and **Integration** all green on `ab2c560` / `3e7e2f1`
- **Docs:** `mkdocs build --strict` clean
