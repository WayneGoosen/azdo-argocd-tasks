# Argo CD Pipeline Tasks

Azure Pipelines tasks for [Argo CD](https://argo-cd.readthedocs.io) that talk to the Argo CD
REST API directly — no CLI download, no gRPC, no 240 MB per pipeline run.

> **Status: 1.0.0, not yet published.** All three Phase 1 tasks are complete and tested.
> See the [roadmap](#roadmap).

**Documentation: [waynegoosen.github.io/azdo-argocd-tasks](https://waynegoosen.github.io/azdo-argocd-tasks/)**

## Why this exists

The Marketplace alternatives are a sync-only task last verified against Argo CD 1.6, and a
closed-source extension with no public repository. Most teams end up hand-rolling
`argocd app sync` plus `argocd app wait` in a script step, which means downloading a
~240 MB CLI binary on every hosted-agent run and debugging gRPC through their ingress.

This extension calls the Argo CD REST gateway over ordinary HTTPS instead:

- **Nothing to download.** Pure Node, so it works on air-gapped and self-hosted agents.
- **No gRPC ingress problems.** No HTTP/2 requirement, no `--grpc-web`, no
  `--grpc-web-root-path`.
- **Real pipeline integration.** Typed output variables, a Markdown run summary with the
  application table and a rendered diff, and exit codes that distinguish "degraded" from
  "still progressing".

## Quick start

Add an **Argo CD** service connection (Project settings → Service connections), then:

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

### Gate a pull request on the diff

```yaml
- task: ArgoCDApp@1
  displayName: Show what would change
  inputs:
    connection: 'argocd-prod'
    command: 'diff'
    applications: 'payments-api'
    project: 'payments'
    failOnDiff: false      # report as "succeeded with issues", do not block
```

### Wait on an app-of-apps by label

```yaml
- task: ArgoCDApp@1
  displayName: Wait for the application
  inputs:
    connection: 'argocd-prod'
    command: 'wait'
    selector: 'app.kubernetes.io/instance=platform'
    project: 'platform'
    waitFor: 'sync,health'
    timeoutSeconds: '900'
```

## Tasks

| Task | What it does |
|---|---|
| **`ArgoCDApp@1`** | Get status, sync, wait, diff or refresh applications over the REST API. No download. |
| **`ArgoCDInstall@1`** | Download, verify and cache the `argocd` CLI, and put it on PATH. |
| **`ArgoCDCli@1`** | Run any `argocd` command with the connection's server and token injected. |
| **`ArgoCDProject@1`** | Read projects; mint and revoke project role tokens. |
| **`ArgoCDAccount@1`** | Manage local account tokens, and check what a token may do. |
| **`ArgoCDAppSet@1`** | Manage ApplicationSets, and preview the Applications they generate. |

Reach for `ArgoCDApp@1` first. The CLI tasks are the escape hatch for what REST cannot do:
`app diff --local`, `--core` mode, `admin` subcommands, and features newer than this extension.

```yaml
- task: ArgoCDInstall@1
  displayName: Install Argo CD CLI
  inputs:
    connection: 'argocd-prod'
    version: 'server'        # match the server you are talking to

- task: ArgoCDCli@1
  displayName: Run argocd
  inputs:
    connection: 'argocd-prod'
    arguments: 'app diff payments-api --local ./manifests'
    workingDirectory: '$(Build.SourcesDirectory)'
```

> **Cost warning.** The `argocd` binary is ~250 MB. The tool cache only persists on
> **self-hosted** agents, so on Microsoft-hosted agents `ArgoCDInstall@1` downloads it on
> every run. That is precisely the cost `ArgoCDApp@1` avoids. For air-gapped or
> bandwidth-sensitive setups, set the pipeline variable `ARGOCD_CLI_MIRROR` to an internal
> mirror laid out as `<base>/releases/download/<tag>/<asset>`.

## ArgoCDApp commands

| Command | What it does |
|---|---|
| `get` | Read sync and health status, optionally refreshing first. |
| `sync` | Sync one or more applications, then wait for them to converge. |
| `wait` | Wait for applications to reach a condition without syncing. |
| `diff` | Compare desired and live state, and publish a rendered diff. |
| `refresh` | Refresh from Git (optionally hard), then report status. |
| `history` | List deployment history — the IDs a rollback targets. |
| `rollback` | Roll back to a previous revision, then wait for it to converge. |
| `action` | Run a resource action such as `restart`, or list what is available. |
| `manifests` | Render desired or live manifests and publish them as an artifact. |
| `logs` | Collect pod logs and publish them as an artifact. |
| `terminate` | Cancel an in-flight operation. |
| `create` | Create or upsert Applications from a manifest file. |
| `set` / `unset` | Change deployment fields on the live spec, and remove them again. |
| `delete` | Delete Applications — guarded. |

### Rolling back a bad deploy

```yaml
- task: ArgoCDApp@1
  displayName: Roll back the application
  inputs:
    connection: 'argocd-prod'
    command: 'rollback'
    applications: 'payments-api'
    project: 'payments'
    historyId: 'previous'      # or an explicit ID from the history command
    wait: true
    timeoutSeconds: '600'
```

> Argo CD **refuses to roll back an application with automated sync enabled**, because the
> controller would immediately sync it forward again. The task detects this before making the
> request and says so. The GitOps-native alternative is to revert in Git and let Argo CD sync
> that — which also leaves an audit trail.

### Bootstrapping applications from a manifest

```yaml
- task: ArgoCDApp@1
  displayName: Create the application
  inputs:
    connection: 'argocd-prod'
    command: 'create'
    manifestFile: 'gitops/applications.yaml'   # multi-document YAML is fine
    upsert: true
```

### Changing the live spec — and why you probably shouldn't

```yaml
- task: ArgoCDApp@1
  displayName: Update the application spec
  inputs:
    connection: 'argocd-prod'
    command: 'set'
    applications: 'payments-api'
    project: 'payments'
    kustomizeImages: 'payments-api:$(Build.BuildId)'
```

> `set` changes the **live** Application spec, which puts the cluster ahead of Git. Argo CD
> will report the application OutOfSync until you commit the change, or silently revert it if
> self-heal is on. The task warns about this every run. Committing the image bump to your GitOps
> repository and syncing is the durable alternative.

> There is no separate `image` command: bump a Kustomize image with `kustomizeImages`, or a Helm
> chart's image tag with `helmParameters`.

### Deleting an application

```yaml
- task: ArgoCDApp@1
  displayName: Delete the application
  inputs:
    connection: 'argocd-prod'
    command: 'delete'
    applications: 'payments-preview'
    project: 'payments'
    confirm: true              # required
    propagationPolicy: 'foreground'
```

> `delete` **does not accept label selectors** — every application must be named explicitly, and
> `confirm: true` is mandatory. Deleting an Argo CD application also deletes the resources it
> manages, and a mistyped selector is an expensive way to find that out.

### Restarting a workload

```yaml
- task: ArgoCDApp@1
  displayName: Run a resource action
  inputs:
    connection: 'argocd-prod'
    command: 'action'
    applications: 'payments-api'
    project: 'payments'
    resource: 'apps:Deployment:payments-api'
    action: 'restart'          # leave empty to list available actions
```

Full input reference: [**https://waynegoosen.github.io/azdo-argocd-tasks/task-inputs/**](https://waynegoosen.github.io/azdo-argocd-tasks/task-inputs/).

## Output variables

Every command sets `appsJson`; single-application runs also set scalars.

```yaml
- task: ArgoCDApp@1
  displayName: Read application status
  name: argocd
  inputs: { connection: 'argocd-prod', command: 'get', applications: 'payments-api', project: 'payments' }

- script: echo "Health is $(argocd.healthStatus) at $(argocd.revision)"
```

| Variable | Notes |
|---|---|
| `syncStatus`, `healthStatus`, `revision` | Single-application runs |
| `operationPhase`, `operationMessage`, `appUrl` | Single-application runs |
| `appsJson` | JSON array covering every application acted on |
| `hasDiff`, `diffResourceCount` | `diff` command only |

## Task results

| Result | When |
|---|---|
| **Failed** | A health status in `failOnHealth` (default `Degraded,Missing`), a failed sync operation, or a timeout with `failOnTimeout` on. |
| **SucceededWithIssues** | Out of sync with `failOnOutOfSync` off, differences with `failOnDiff` off, or a timeout with `failOnTimeout` off. |
| **Succeeded** | The requested conditions were met. |

A run covering several applications fails if any single application fails.

## Set `project` — it is not optional in practice

Argo CD deliberately refuses to distinguish "this application does not exist" from "your
token may not see it": without a `project`, both return `permission denied`. Supplying
`project` turns a missing application into a real 404, so a typo stops looking like a
broken token. The task warns when you omit it.

## Previewing an ApplicationSet

`generate` renders the Applications an ApplicationSet *would* produce without persisting
anything, which makes a pull request able to show what a change adds or removes:

```yaml
- task: ArgoCDAppSet@1
  displayName: Preview generated applications
  name: preview
  inputs:
    connection: 'argocd-prod'
    command: 'generate'
    generateFrom: 'file'                 # or 'name', to preview the live one
    manifestFile: 'gitops/appsets/payments.yaml'

- script: echo "$(preview.generatedAppCount) application(s) would be generated"
```

> This is **not** the same as `create` with `dryRun`. `dryRun` answers "what would this
> ApplicationSet own?"; `generate` answers "what would it produce?".

> `delete` on an ApplicationSet also deletes **every Application it generated**, and the
> resources those manage, unless `preserveResourcesOnDeletion` is set. Like `ArgoCDApp@1`'s
> delete, it takes explicit names only and requires `confirm: true` — and it tells you how many
> applications are about to go with it.

## Rotating the token

The token in your service connection expires, and when it does every pipeline using it fails at
once. `ArgoCDProject@1` and `ArgoCDAccount@1` exist so you can rotate it on a schedule:

```yaml
- task: ArgoCDProject@1
  displayName: Mint an Argo CD token
  name: mint
  inputs:
    connection: 'argocd-rotation'   # a separate token that may only manage tokens
    command: 'create-token'
    project: 'payments'
    role: 'ado-ci'
    expiresIn: '90d'

# $(mint.token) is a secret output variable; $(mint.tokenId) revokes it later.
```

Mint, update the connection, **verify**, then revoke — in that order. The full runbook is in
[the token rotation guide](https://waynegoosen.github.io/azdo-argocd-tasks/token-rotation/), with a working pipeline in
[`samples/pipelines/rotate-token.yml`](samples/pipelines/rotate-token.yml).

### Checking permissions before you need them

```yaml
- task: ArgoCDAccount@1
  displayName: Check permissions
  inputs:
    connection: 'argocd-prod'
    command: 'can-i'
    resource: 'applications'
    action: 'sync'
    subresource: 'payments/*'
    failIfDenied: true      # assert up front rather than failing halfway
```

## Security

Use an Argo CD **project role token**, scoped to one AppProject:

```sh
argocd proj role create-token payments ado-ci --expires-in 90d
```

The RBAC policy to grant it, and notes on token rotation, are in
[the security guide](https://waynegoosen.github.io/azdo-argocd-tasks/security/). Sample manifests live in [`samples/rbac`](samples/rbac).

The token is masked with `##vso[task.setsecret]` before the task makes any request, and is
only ever sent in an `Authorization` header — never on a command line.

## Compatibility

| | |
|---|---|
| Argo CD | 3.3, 3.4, 3.5 (the versions upstream supports) |
| Agents | Windows, Linux, macOS; hosted, self-hosted, Managed DevOps Pools |
| Node handler | `Node24`, falling back to `Node20_1`; minimum agent 4.248.0 |
| CLI platforms | Linux, macOS and Windows on amd64; arm64 except on Windows, which falls back to amd64 |

The client is verified against the Argo CD OpenAPI spec for the oldest supported minor by a
contract test, so an upstream breaking change fails CI rather than a deployment.

## Roadmap

- **Done**: six tasks. PRD Phases 1-3 complete. Icons shipped, manifest flipped public.
- **Next**: publishing — marketplace screenshots and a verified publisher.
- **Later**: Phase 4 (clusters, repositories, certificates, GPG keys, Argo Rollouts).

Current state, outstanding work, dated commitments, gotchas, and the reasoning behind everything
deliberately *not* built is in [`STATUS.md`](STATUS.md).

## Development

```sh
npm ci
npm test          # 469 unit, contract and end-to-end tests
npm run build     # esbuild bundle per task into dist/
npm run package   # build a .vsix
```

`npm test` runs the real bundled artifacts against local replay servers, so bundling
regressions are caught before packaging. Integration tests against a real Argo CD are skipped
unless `ARGOCD_TEST_SERVER` is set:

```sh
./scripts/kind-argocd.sh 3.5.3
source .argocd-env && npx vitest run test/integration
```

CI runs those across Argo CD 3.3, 3.4 and 3.5.

See [`.github/RELEASING.md`](.github/RELEASING.md) for the release process.

## License

[Apache-2.0](LICENSE).

Argo and Argo CD are trademarks of The Linux Foundation. This project is not affiliated
with, endorsed by, or sponsored by The Linux Foundation or the Argo project.
