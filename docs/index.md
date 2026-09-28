# Argo CD Pipeline Tasks

Azure Pipelines tasks for [Argo CD](https://argo-cd.readthedocs.io) that talk to the Argo CD
REST API directly — no CLI download, no gRPC, no 240 MB per pipeline run.

!!! tip "Available on the Marketplace"
    [Install the extension](https://marketplace.visualstudio.com/items?itemName=WayneGoosen.argocd-pipeline-tasks) — six tasks, tested against live Argo CD 3.3, 3.4 and 3.5.

## Why this exists

The Marketplace alternatives are a sync-only task last verified against Argo CD 1.6, and a
closed-source extension with no public repository. Most teams end up hand-rolling
`argocd app sync` plus `argocd app wait` in a script step, which means downloading a ~240 MB
CLI binary on every hosted-agent run and debugging gRPC through their ingress.

These tasks call the Argo CD REST gateway over ordinary HTTPS instead.

- **Nothing to download.** Pure Node, so air-gapped and self-hosted agents work unchanged.
- **No gRPC ingress problems.** No HTTP/2 requirement, no `--grpc-web`, no `--grpc-web-root-path`.
- **Built for pipelines.** Typed output variables, a Markdown run summary with an application
  table and a rendered diff, and task results that tell "degraded" apart from "still progressing".

## The tasks

| Task | What it does |
|---|---|
| [`ArgoCDApp@1`](task-inputs.md#argocdapp1) | Get status, sync, wait, diff, roll back, run resource actions, collect logs and manifests, create, set/unset and delete applications. |
| [`ArgoCDAppSet@1`](task-inputs.md#argocdappset1) | Manage ApplicationSets and preview the Applications they generate. |
| [`ArgoCDProject@1`](task-inputs.md#argocdproject1) | Read projects; mint and revoke project role tokens. |
| [`ArgoCDAccount@1`](task-inputs.md#argocdaccount1) | Manage local account tokens, and check what a token may do. |
| [`ArgoCDInstall@1`](task-inputs.md#argocdinstall1) | Download, verify and cache the `argocd` CLI. |
| [`ArgoCDCli@1`](task-inputs.md#argocdcli1) | Run any `argocd` command with authentication injected. |

Reach for `ArgoCDApp@1` first. The CLI tasks are the escape hatch for what REST cannot do:
`app diff --local`, `--core` mode, `admin` subcommands, and features newer than this extension.

## Quick start

Add an **Argo CD** service connection, then:

```yaml
- task: ArgoCDApp@1
  displayName: Deploy payments
  inputs:
    connection: 'argocd-prod'
    command: 'sync'
    applications: 'payments-api'
    project: 'payments'
    prune: true
    syncOptions: |
      CreateNamespace=true
      ServerSideApply=true
    wait: true
    waitFor: 'sync,health'
    timeoutSeconds: '600'
```

[Usage guide](usage.md){ .md-button .md-button--primary }
[Task inputs](task-inputs.md){ .md-button }

## Compatibility

| | |
|---|---|
| Argo CD | 3.3, 3.4, 3.5 — the versions upstream supports |
| Agents | Windows, Linux, macOS; hosted, self-hosted, Managed DevOps Pools |
| Node handler | `Node24`, falling back to `Node20_1`; minimum agent 4.248.0 |

The client is verified against the Argo CD OpenAPI spec for the oldest supported minor by a
contract test, and exercised against real Argo CD 3.3, 3.4 and 3.5 servers in CI — so an upstream
change fails the build rather than a deployment.

---

Argo and Argo CD are trademarks of The Linux Foundation. This project is not affiliated with,
endorsed by, or sponsored by The Linux Foundation or the Argo project.
