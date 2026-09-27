# Releasing

## The four workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `pr.yml` | PR to `main` | Typecheck, test, package, assert the VSIX assets, comment the version |
| `main.yml` | Push to `main` | Stamp the version, package, cut a GitHub release with the `.vsix`. **Does not publish.** |
| `marketplace-publish.yml` | Manual | Download a release's `.vsix` and publish it to the Marketplace |
| `dev-publish.yml` | Manual | Publish a private dev build and share it with a test organisation |
| `pages.yml` | Push to `main` touching `docs/` | Build the MkDocs site and deploy it to GitHub Pages |

Publishing is separate from releasing on purpose: **the Marketplace rejects re-uploading a
version that already exists.** Once `0.2.0` is published it can never be replaced, only
superseded. Cutting a GitHub release first means the artifact can be tested before that
one-way door.

## Versioning

GitVersion calculates the version; `scripts/stamp-version.mjs` writes it into
`vss-extension.json` and every `tasks/*/task.json`. The values committed to git are
placeholders the release overwrites.

| Commit message | Effect |
|---|---|
| `feat: ...` or `+semver: minor` | Minor bump |
| `fix: ...` or `+semver: patch` | Patch bump |
| `+semver: none` | No bump |

Two rules worth internalising:

1. **GitVersion needs a tag anchor.** Without one it counts from repo init and produces
   absurd numbers. Every checkout that runs GitVersion uses `fetch-depth: 0`.
2. **A major bump is a breaking change for consumers.** It rewrites the `ArgoCDApp@N`
   reference in every pipeline using this extension. `stamp-version.mjs` refuses to change a
   task's major for exactly this reason — a new major means a new versioned task directory
   (`tasks/ArgoCDAppV2/`) shipped alongside the old one, not an edit to the existing one.

Pre-release suffixes are rejected: the Marketplace renders them badly. Plain `M.m.p` only.

**Why the first release is 1.0.0 and not 0.1.0.** A task's major version *is* its public
reference — pipelines write `ArgoCDApp@1` — and the task directories are `ArgoCD*V1`. Shipping
0.x would mean `ArgoCDApp@0`, and the eventual 1.0 would then rewrite the reference in every
consumer pipeline purely for version cosmetics. `stamp-version.mjs` enforces this by refusing
to change a task's declared major: a genuine major bump means a new `tasks/ArgoCD*V2/`
directory shipped alongside the old one.

## First publish

The very first publish must be done **manually** through
<https://marketplace.visualstudio.com/manage> to create the publisher and extension records.
`marketplace-publish.yml` can only update an extension that already exists.

Before that first publish:

- [x] Replace the placeholder icons. Done — the shipped artwork is deliberately abstract,
      **no Argo logo**, since "ARGO" is a registered trademark of The Linux Foundation and
      this project uses the name nominatively only. `scripts/make-placeholder-icons.mjs`
      now skips existing icons unless given `--force`.
- [x] Flip `"public"` to `true` in `vss-extension.json`. The dev overrides
      (`vss-extension.dev.json`) pin `public: false` so dev builds do not follow it public;
      `test/manifest/extension-manifest.test.ts` asserts that.
- [ ] Add screenshots to `marketplace/images/` and declare them in `vss-extension.json`.
      `pr.yml` warns about their absence rather than failing. See below.
- [ ] Marketplace images must use **absolute** `raw.githubusercontent.com` URLs. Relative
      paths do not render on the Marketplace.
- [ ] Never list `marketplace/` in `vss-extension.json` `files[]`. tfx silently drops the
      `Content.Details` and `Screenshots.N` assets if you do, and the listing comes out
      blank. Both CI workflows assert on the packed `extension.vsixmanifest` to catch it.
- [ ] Get the publisher **verified** by Microsoft. An unverified publisher cannot list an
      extension publicly, whatever the manifest says.

### Screenshots

Capture these from a real pipeline run against a real Argo CD, and drop them in
`marketplace/images/`:

| File | What it should show |
|---|---|
| `01-sync-summary.png` | The **Extensions** tab of a completed run: the run summary with its application table, sync and health columns. |
| `02-diff.png` | A `diff` run summary with a rendered diff block. |
| `03-pipeline-steps.png` | The job step list with sensible `displayName`s, showing green Argo CD steps. |

Then declare them — order is the display order on the listing:

```json
"screenshots": [
    { "path": "marketplace/images/01-sync-summary.png" },
    { "path": "marketplace/images/02-diff.png" },
    { "path": "marketplace/images/03-pipeline-steps.png" }
]
```

Before capturing, check the frame for anything you would not put on a public page: the
organisation and project names in the breadcrumb, repository URLs, internal hostnames, and
any red or warning lines from unrelated steps. Crop to the pane that matters — roughly
1366px wide is plenty; the Marketplace scales anything larger down.

`pages.yml` copies `marketplace/images/*.png` into the docs site at build time, so the same
files serve both the listing and the docs. `docs/assets/images/` is generated, not committed.

## Credentials — and the deadline

`marketplace-publish.yml` uses `secrets.ADO_PUBLISHER_PAT`, a PAT with the **Marketplace:
Manage** scope across all accessible organizations.

> **Microsoft decommissions all global PATs on 1 December 2026.** This publishing path stops
> working on that date.

The replacement is workload identity federation, and it is confirmed available:
`azure-devops-extension-tasks@5` defaults to `connectTo: AzureRM` and acquires an Entra token
for resource `499b84ac-1321-427f-aa17-267ca6975798` internally — no PAT, and no
`AzureCLI@2` pre-step.

To migrate:

1. Create an Azure Resource Manager service connection using *Workload Identity Federation
   (automatic)*.
2. Add that connection's application/identity ID as a **member of the Marketplace publisher**
   (`https://marketplace.visualstudio.com/manage` → publisher → Members → Add).
3. Switch publishing to `PublishAzureDevOpsExtension@5` with `connectTo: 'AzureRM'`, or
   acquire the token in the GitHub workflow via OIDC → Entra and pass it to
   `tfx --auth-type pat -t <token>`.

Note `TfxInstaller@5` defaults to `version: builtin` — pin `latest` or an explicit `v0.24.x`
so validation runs against a tfx that recognises the `Node24` handler (>= 0.22.5).

## Day to day

1. Merge a PR to `main`. `main.yml` cuts `vX.Y.Z` with the `.vsix` attached.
2. Test it: run `dev-publish.yml` against a scratch organisation, or install the `.vsix`
   manually. Do **not** use an organisation that has the public extension installed — the dev
   build reuses the production task GUID and the registrations collide.
3. When satisfied, run `marketplace-publish.yml` with that tag.

## The documentation site

`docs/` is the source of <https://waynegoosen.github.io/azdo-argocd-tasks/>, built with Material
for MkDocs and deployed by `pages.yml` on any push to `main` that touches it. Enable **Pages ->
Build and deployment -> GitHub Actions** in the repository settings before the first run.

Preview locally with:

```sh
pip install -r docs/requirements.txt
mkdocs serve
```

CI builds with `--strict`, so a broken internal link fails the build rather than shipping.

Internal working documents live in `internal/`, which is gitignored and never reaches the site.

## Not automated yet

See [`../STATUS.md`](../STATUS.md) for the full picture: current state, blockers, gotchas and deferred work.


- CHANGELOG generation. Release notes come from `gh release create --generate-notes`.
- Integration tests have never actually run. `integration.yml` and `scripts/kind-argocd.sh`
  are written and wired up, but nothing has been pushed, so no workflow has executed. Run the
  matrix before trusting any "verified against 3.3/3.4/3.5" claim.
- The PAT to workload-identity migration described above.
