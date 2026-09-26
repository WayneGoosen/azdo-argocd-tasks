---
project: azdo-argocd-tasks
domain: waynegoosen
status: In development
priority: P2
stage: pre-release
updated: 2026-09-25
repo: https://github.com/WayneGoosen/azdo-argocd-tasks.git
---

# Argo CD Pipeline Tasks — Status

**One-liner:** Azure Pipelines tasks for Argo CD that call the REST API directly — no CLI download, no gRPC.

The single source of truth for this project: where it is, what is next, what is blocked, and the
things that will bite you. Written so it can be picked up cold.

## 🎯 Now — active focus

- [ ] **Commit and push.** 147 files, one commit, nothing pushed. Everything below exists only on
      one machine, and no CI workflow has ever executed.

## ⏭️ Next — committed pipeline

- [ ] **Run the integration matrix.** `integration.yml` + `scripts/kind-argocd.sh` are written and
      wired up but have **never run**. Until they do, "verified against Argo CD 3.3/3.4/3.5" is a
      claim about the *spec*, not the servers.
- [ ] **Tag `v1.0.0`.** GitVersion has no anchor; without one it counts from repo init and
      produces absurd versions.
- [ ] **Enable GitHub Pages** — Settings → Pages → Build and deployment → GitHub Actions.
- [ ] **Publish**: real icons, marketplace screenshots, verified publisher, flip `"public": true`.
      The first publish must be manual through the Marketplace UI to create the extension record.

## 💡 Later — backlog

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
| **Nothing is pushed** | No CI has run. The integration matrix — the only verification against real servers — is unproven. |
| **Verified publisher** | Required by Microsoft before an extension can be listed publicly. Needs your account. |
| **Icons and screenshots** | Placeholders only. Deliberately abstract: "ARGO" is a Linux Foundation trademark, so no Argo mark. |
| **`internal/prd.md` is gitignored** | The original architecture research exists only on this machine. Move it somewhere tracked if it should survive. |

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

- **Last commit:** 2026-09-23 (1 commit total — the initial import)
- **Unpushed:** 0 ahead, but **147 files uncommitted**
- **Working tree:** uncommitted changes
- **Tests:** 456 passing, 30 integration skipped (no live server)
- **Build:** 6 task bundles, each self-contained, 556 KiB VSIX
- **Docs:** `mkdocs build --strict` clean
