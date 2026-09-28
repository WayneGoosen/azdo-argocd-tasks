# Usage

Every task takes an **Argo CD service connection**, which carries the server URL and a token.
See [Security](security.md) for which credential to use and how to scope it.

## Always set `displayName`

In a YAML pipeline, a step with no `displayName` shows the **task identifier** in the run —
`ArgoCDInstall`, not the friendly name. That is Azure DevOps behaviour, not something the task
can change: a task's `name` is its `TaskName@1` reference and cannot contain spaces.

```yaml
- task: ArgoCDInstall@1
  displayName: Install Argo CD CLI    # ← the step header in the run
```

Every example below sets one.

## Deploying

Sync an application and wait for it to become healthy. This is the common case.

```yaml
- task: ArgoCDApp@1
  name: argocd
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

- script: echo "Deployed $(argocd.revision) — $(argocd.appUrl)"
```

!!! tip "Use a deployment job"
    Running the sync inside a `deployment:` job targeting an Environment gives you deployment
    history, approvals and an exclusive lock for free — none of which the task has to implement.

### Always set `project`

Argo CD deliberately refuses to distinguish "this application does not exist" from "your token
may not see it": without a `project`, both return `permission denied`. Supplying it turns a
missing application into a real 404, so a typo stops looking like a broken token. The task warns
when you omit it.

### Waiting

`waitFor` takes a comma-separated list of conditions that must all hold: `sync`, `health`,
`operation`, `suspended`. `suspended` is for Argo Rollouts pause points — `Suspended` only counts
as healthy when you ask for it.

A **failed sync operation** stops the wait immediately. `Degraded` and `Missing` do **not** —
both occur transiently during a normal rollout, so they fail the task by being the state at
timeout rather than by aborting early.

## Reviewing a change

Show reviewers what would actually change in the cluster, without blocking the build:

```yaml
- task: ArgoCDApp@1
  displayName: Show what would change
  inputs:
    connection: 'argocd-prod'
    command: 'diff'
    applications: 'payments-api'
    project: 'payments'
    failOnDiff: false     # report as "succeeded with issues"
```

The diff is rendered from Argo CD's normalized-live and predicted-live states — the same
comparison the UI shows — as a collapsible unified diff per changed resource in the run summary.

For ApplicationSets, `generate` renders the Applications a change *would* produce without
persisting anything:

```yaml
- task: ArgoCDAppSet@1
  displayName: Preview generated applications
  name: preview
  inputs:
    connection: 'argocd-prod'
    command: 'generate'
    generateFrom: 'file'
    manifestFile: 'gitops/appsets/payments.yaml'
```

## Recovering

Roll back to the previous revision:

```yaml
- task: ArgoCDApp@1
  displayName: Roll back the application
  inputs:
    connection: 'argocd-prod'
    command: 'rollback'
    applications: 'payments-api'
    project: 'payments'
    historyId: 'previous'
    wait: true
```

!!! warning "Automated sync blocks rollback"
    Argo CD refuses to roll back an application with automated sync enabled, because the
    controller would immediately sync it forward again. The task detects this **before** making
    the request and says so. The GitOps-native alternative is to revert in Git and let Argo CD
    sync that — which also leaves an audit trail.

Collect evidence when something fails:

```yaml
- task: ArgoCDApp@1
  displayName: Collect logs for triage
  condition: failed()
  inputs:
    connection: 'argocd-prod'
    command: 'logs'
    applications: 'payments-api'
    project: 'payments'
    tailLines: '500'
```

Logs and manifests are written to a file and published as a pipeline artifact, with a bounded
tail echoed to the log.

## Targeting several applications

Name them one per line, or match them with a label selector:

```yaml
- task: ArgoCDApp@1
  displayName: Wait for the application
  inputs:
    connection: 'argocd-prod'
    command: 'wait'
    selector: 'app.kubernetes.io/instance=platform'
    project: 'platform'
    waitFor: 'sync,health'
    timeoutSeconds: '1800'
```

A run covering several applications fails if any single one fails. Use `namespace/name` in
`applications` for app-in-any-namespace installs.

!!! danger "Destructive commands take names only"
    `delete` — on both `ArgoCDApp@1` and `ArgoCDAppSet@1` — refuses label selectors and requires
    `confirm: true`. Deleting an application also deletes the resources it manages, and deleting
    an ApplicationSet deletes every Application it generated.

## Using the CLI

When you need something the REST API cannot do — `app diff --local`, `--core` mode, `admin`
subcommands — install the CLI and run it with authentication injected:

```yaml
- task: ArgoCDInstall@1
  displayName: Install Argo CD CLI
  inputs:
    connection: 'argocd-prod'
    version: 'server'      # match the server you are talking to

- task: ArgoCDCli@1
  displayName: Run argocd
  inputs:
    connection: 'argocd-prod'
    arguments: 'app diff payments-api --local ./manifests'
    workingDirectory: '$(Build.SourcesDirectory)'
```

!!! note "The CLI costs bandwidth"
    The `argocd` binary is ~250 MB and the tool cache only persists on **self-hosted** agents, so
    Microsoft-hosted agents download it every run. Set the pipeline variable `ARGOCD_CLI_MIRROR`
    to an internal mirror laid out as `<base>/releases/download/<tag>/<asset>` for air-gapped or
    bandwidth-sensitive setups.

## Task results

| Result | When |
|---|---|
| **Failed** | A health status in `failOnHealth` (default `Degraded,Missing`), a failed sync operation, or a timeout with `failOnTimeout` on. |
| **SucceededWithIssues** | Out of sync with `failOnOutOfSync` off, differences with `failOnDiff` off, or a timeout with `failOnTimeout` off. |
| **Succeeded** | The requested conditions were met. |

## Output variables

Give the step a `name` and reference them as `$(stepName.variable)`:

```yaml
- task: ArgoCDApp@1
  displayName: Read application status
  name: argocd
  inputs:
    connection: 'argocd-prod'
    command: 'get'
    applications: 'payments-api'
    project: 'payments'

- script: echo "Health is $(argocd.healthStatus) at $(argocd.revision)"
```

`name` is what makes this work, and it is easy to miss. Without it the task still runs and still
sets its outputs, but Azure DevOps assigns the step a **generated** reference name — `ArgoCDApp1`
for the first such step, `ArgoCDApp2` for the next — so `$(argocd.healthStatus)` resolves to
nothing. No warning is logged.

If you are debugging this, dump the environment in the following step. Output variables appear as
`<REFERENCE_NAME>_<VARIABLE>`, upper-cased:

```yaml
- bash: env | grep -i argocd | sort
```

Seeing `ARGOCDAPP1_HEALTHSTATUS` rather than `ARGOCD_HEALTHSTATUS` means the step had no `name`,
and the variables are there under the generated prefix.

Two further constraints, both Azure DevOps behaviour rather than anything this task controls:

- **Only later steps can read them.** A variable set by a step is not visible to that same step.
- **Across jobs or stages you need the long form**, plus an explicit `dependsOn`:

```yaml
- job: verify
  dependsOn: deploy
  variables:
    health: $[ dependencies.deploy.outputs['argocd.healthStatus'] ]
  steps:
    - script: echo "Health was $(health)"
```

Note the task's step name (`argocd`) and the output name are one quoted string inside the
brackets, and `$[ ]` is not interchangeable with `$( )` here.

### `revision` on multi-source applications

For an application with several sources (`spec.sources`), Argo CD reports one revision per source
and `revision` holds them comma-separated, in source order.

They are **not all git SHAs**. A Helm chart source reports its *chart version*, so the common
"chart from a registry, values from a repo" application produces something like
`1.2.3,4f9a2c…`. Joined together those cannot be told apart, so the list is also published as
`revisions`, a JSON array:

```yaml
- task: ArgoCDApp@1
  displayName: Read application status
  name: argocd
  inputs:
    connection: 'argocd-prod'
    command: 'get'
    applications: 'payments-api'
    project: 'payments'

- bash: |
    chart=$(echo '$(argocd.revisions)' | jq -r '.[0]')   # the Helm chart version
    values=$(echo '$(argocd.revisions)' | jq -r '.[1]')  # the values repo commit
    echo "chart $chart, values $values"
```

Entries are positional and follow the order of `spec.sources`.

The full list is in the [task inputs reference](task-inputs.md).
