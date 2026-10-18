---
applyTo: ".github/workflows/**"
---

# Workflows

A tag on `uses:` is mutable. Pin every action to a **full commit SHA** with
the version as a trailing comment, matching the rest of this repo:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

Dependabot's `github-actions` group rewrites both the SHA and the comment.
Do not "tidy" pins back to `@v4`.

## What a real failure looks like

- **Unpinned action on a publishing workflow.** `marketplace-publish.yml`
  and `dev-publish.yml` see `ADO_PUBLISHER_PAT`. Whoever can move that
  tag chooses what runs with the publisher credential.
- **`marketplace/` listed in `vss-extension.json` `files[]`.** tfx drops
  `Content.Details` / screenshots with no error. The VSIX assertion in
  `pr.yml` / `main.yml` is what catches it — do not delete those steps.
- **GitVersion without `fetch-depth: 0`.** It counts from repo init and
  stamps an absurd version onto a Marketplace artifact you cannot replace.
- **CI Node bumped off 20.** Task tests spawn the bundle with
  `process.execPath`. Node 22 CI stops validating `Node20_1`.
- **Template expansion into `run:` from untrusted input.** Pass
  `workflow_dispatch` inputs and computed outputs through `env:` and
  expand the shell variable, not `${{ }}` inside the script.

## Permissions

Do not loosen workflow or job `permissions`. Prefer job-scoped write
(`pull-requests: write` only on the job that comments; `pages` /
`id-token` only on the Pages deploy job). Set
`persist-credentials: false` on checkout unless a later step must push
with the default token.

`zizmor` and `actionlint` run on every PR. If you must suppress a zizmor
finding, do it narrowly (`# zizmor: ignore[rule] reason`) on the span
it flags, and explain the reason in the PR.
