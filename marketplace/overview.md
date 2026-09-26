# Argo CD Pipeline Tasks

Sync, wait on, diff and report **Argo CD** applications from Azure Pipelines — over the Argo CD
REST API, with nothing to download.

> **Pre-release.** The `ArgoCDApp@1` task is complete and tested. CLI installer tasks are coming next.

## Why not just script the CLI?

Most pipelines hand-roll `argocd app sync` plus `argocd app wait`. That means downloading a
~240 MB binary on every hosted-agent run, and getting gRPC through your ingress — HTTP/2
end-to-end, or `--grpc-web` plus `--grpc-web-root-path`.

These tasks call the Argo CD REST gateway over ordinary HTTPS instead.

- **Nothing to download** — pure Node, so air-gapped and self-hosted agents work unchanged.
- **No gRPC ingress problems** — plain HTTPS/1.1 JSON.
- **Built for pipelines** — typed output variables, a Markdown run summary with an application
  table and a rendered diff, and task results that tell "degraded" apart from "still progressing".

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

## Commands

| Command | What it does |
|---|---|
| `get` | Read sync and health status, optionally refreshing first. |
| `sync` | Sync one or more applications, then wait for them to converge. |
| `wait` | Wait for applications to reach a condition without syncing. |
| `diff` | Compare desired and live state, and publish a rendered diff to the run summary. |
| `refresh` | Refresh from Git (optionally hard), then report status. |

Target applications by name, by `namespace/name` for app-in-any-namespace installs, or by
label selector for an app-of-apps.

## Output variables

```yaml
- task: ArgoCDApp@1
  name: argocd
  inputs:
    connection: 'argocd-prod'
    command: 'get'
    applications: 'payments-api'
    project: 'payments'

- script: echo "Health is $(argocd.healthStatus) at $(argocd.revision)"
```

`syncStatus`, `healthStatus`, `revision`, `operationPhase`, `operationMessage`, `appUrl` for a
single application; `appsJson` for every run; `hasDiff` and `diffResourceCount` for `diff`.

## Task results

- **Failed** — a health status in `failOnHealth` (default `Degraded,Missing`), a failed sync
  operation, or a timeout with `failOnTimeout` on.
- **SucceededWithIssues** — out of sync, or a diff found, when configured not to fail.
- **Succeeded** — the requested conditions were met.

## Security

Authenticate with an Argo CD **project role token**, scoped to a single AppProject:

```sh
argocd proj role create-token payments ado-ci --expires-in 90d
```

The token is masked before the task makes any request, and is only ever sent in an
`Authorization` header — never on a command line. A local account API token works too when a
step needs to cross projects.

## Compatibility

Argo CD **3.3, 3.4 and 3.5**, the versions upstream supports. Windows, Linux and macOS agents;
hosted, self-hosted and Managed DevOps Pools. Runs on the `Node24` handler, falling back to
`Node20_1`; minimum agent version 4.248.0.

## Links

- [Documentation and source](https://github.com/WayneGoosen/azdo-argocd-tasks)
- [Report an issue](https://github.com/WayneGoosen/azdo-argocd-tasks/issues)
- [Apache-2.0 licence](https://github.com/WayneGoosen/azdo-argocd-tasks/blob/main/LICENSE)

---

Argo and Argo CD are trademarks of The Linux Foundation. This project is not affiliated with,
endorsed by, or sponsored by The Linux Foundation or the Argo project.
