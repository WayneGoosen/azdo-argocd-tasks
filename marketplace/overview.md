# Argo CD Pipeline Tasks

Sync, wait on, diff and report **Argo CD** applications from Azure Pipelines — over the Argo CD
REST API, with nothing to download.

## Why not just script the CLI?

Most pipelines hand-roll `argocd app sync` plus `argocd app wait`. That means downloading a
~250 MB binary on every hosted-agent run, and getting gRPC through your ingress — HTTP/2
end-to-end, or `--grpc-web` plus `--grpc-web-root-path`.

These tasks call the Argo CD REST gateway over ordinary HTTPS instead.

- **Nothing to download** — pure Node, so air-gapped and self-hosted agents work unchanged.
- **No gRPC ingress problems** — plain HTTPS/1.1 JSON.
- **Built for pipelines** — typed output variables, a Markdown run summary with an application
  table and a rendered diff, and task results that tell "degraded" apart from "still progressing".

The CLI is still there when you need it: `ArgoCDInstall@1` and `ArgoCDCli@1` cover the commands
the REST API does not expose.

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

> Step headers show the task's `name`, not its friendly name, so a step without a
> `displayName` reads as `ArgoCDApp`. Always set `displayName`.

## The tasks

| Task | What it does |
|---|---|
| **`ArgoCDApp@1`** | The main one. Status, sync, wait, diff, refresh, history, rollback, resource actions, manifests, logs, terminate, and create/set/unset/delete. |
| **`ArgoCDAppSet@1`** | ApplicationSets: list, get, create, delete, and `generate` to preview the Applications one would produce. |
| **`ArgoCDProject@1`** | Read AppProjects and mint or revoke project role tokens. |
| **`ArgoCDAccount@1`** | Local account tokens, plus `can-i` to check what a token is actually permitted to do. |
| **`ArgoCDInstall@1`** | Download, checksum-verify and tool-cache the `argocd` CLI, then add it to `PATH`. |
| **`ArgoCDCli@1`** | Run any `argocd` command with the service connection's server and token injected — never on the command line. |

### `ArgoCDApp@1` commands

| Command | What it does |
|---|---|
| `get` | Read sync and health status, optionally refreshing first. |
| `sync` | Sync one or more applications, then wait for them to converge. |
| `wait` | Wait for applications to reach a condition without syncing. |
| `diff` | Compare desired and live state, and publish a rendered diff to the run summary. |
| `refresh` | Refresh from Git (optionally hard), then report status. |
| `history` | List deployment history for an application. |
| `rollback` | Roll back to a previous history entry. |
| `action` | Run a resource action, such as restarting a Deployment. |
| `manifests` | Fetch rendered manifests for a revision, to a file and a build artifact. |
| `logs` | Pull pod logs for a managed resource. |
| `terminate` | Cancel an in-flight sync operation. |
| `create` / `set` / `unset` / `delete` | Manage Applications declaratively from a manifest file. |

Target applications by name, by `namespace/name` for app-in-any-namespace installs, or by
label selector for an app-of-apps.

## Output variables

```yaml
- task: ArgoCDApp@1
  displayName: Check payments
  name: argocd
  inputs:
    connection: 'argocd-prod'
    command: 'get'
    applications: 'payments-api'
    project: 'payments'

- script: echo "Health is $(argocd.healthStatus) at $(argocd.revision)"
```

`syncStatus`, `healthStatus`, `revision`, `operationPhase`, `operationMessage` and `appUrl` for a
single application; `appsJson` for every run; `hasDiff` and `diffResourceCount` for `diff`. Every
task declares its own — see the [task input reference](https://waynegoosen.github.io/azdo-argocd-tasks/task-inputs/).

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
`Authorization` header — never on a command line, never as a plain pipeline variable. A local
account API token works too when a step needs to cross projects. The
[security guide](https://waynegoosen.github.io/azdo-argocd-tasks/security/) has the RBAC policy
to grant, and [token rotation](https://waynegoosen.github.io/azdo-argocd-tasks/token-rotation/)
covers renewing them from a pipeline.

Destructive commands are guarded: `delete` requires explicit names and `confirm: true`, and
refuses to act on a label selector.

## Compatibility

Argo CD **3.3, 3.4 and 3.5**, the versions upstream supports. Windows, Linux and macOS agents;
hosted, self-hosted and Managed DevOps Pools. Runs on the `Node24` handler, falling back to
`Node20_1`; minimum agent version 4.248.0.

## Links

- [Documentation](https://waynegoosen.github.io/azdo-argocd-tasks/)
- [Source](https://github.com/WayneGoosen/azdo-argocd-tasks)
- [Report an issue](https://github.com/WayneGoosen/azdo-argocd-tasks/issues)
- [Apache-2.0 licence](https://github.com/WayneGoosen/azdo-argocd-tasks/blob/main/LICENSE)

---

Argo and Argo CD are trademarks of The Linux Foundation. This project is not affiliated with,
endorsed by, or sponsored by The Linux Foundation or the Argo project.
