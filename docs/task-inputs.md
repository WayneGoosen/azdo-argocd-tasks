# Task inputs

## ArgoCDApp@1

### Common

| Input | Type | Default | Notes |
|---|---|---|---|
| `connection` | connection | — | **Required.** The Argo CD service connection. |
| `command` | pick list | `sync` | `get`, `sync`, `wait`, `diff`, `refresh`. |
| `applications` | multiline | — | One per line: `name`, or `namespace/name` for app-in-any-namespace. |
| `selector` | string | — | Label selector, used when `applications` is empty. |
| `project` | string | — | The AppProject. **Strongly recommended** — see below. |
| `appNamespace` | string | — | Namespace holding the Application resources. |
| `publishSummary` | boolean | `true` | Publish the Markdown summary to the run. |

Supply either `applications` or `selector`. A per-line namespace in `applications` overrides
`appNamespace`, so one step can target several namespaces.

#### Why `project` matters

Argo CD deliberately returns `permission denied` both for an application that does not exist
and for one your token may not see — it even performs a dummy lookup so response timing
cannot leak existence. Supplying `project` turns a missing application into a real 404, so a
typo stops looking like a broken token. The task warns when it is omitted.

### Sync (`command: sync`)

| Input | Type | Default | Notes |
|---|---|---|---|
| `revision` | string | — | Git revision, tag or chart version. |
| `prune` | boolean | `false` | Delete resources removed from Git. |
| `dryRun` | boolean | `false` | Preview only. Waiting is skipped automatically. |
| `syncStrategy` | pick list | `apply` | `apply` or `hook`. |
| `force` | boolean | `false` | `kubectl apply --force`. |
| `resources` | multiline | — | `KIND:NAME`, `GROUP:KIND:NAME` or `GROUP:KIND:NAME:NAMESPACE`. |
| `syncOptions` | multiline | — | e.g. `CreateNamespace=true`, `ServerSideApply=true`. |
| `retryLimit` | int | `0` | Retries performed by Argo CD itself. |
| `onRunningOperation` | pick list | `fail` | `fail`, `wait` or `terminate`. |

`onRunningOperation` exists because Argo CD rejects a sync while another operation is in
flight, and the raw error is opaque. Use `wait` when several pipelines target one application.

### Waiting (`command: sync` or `wait`)

| Input | Type | Default | Notes |
|---|---|---|---|
| `wait` | boolean | `true` | `sync` only. Turn off to fire and forget. |
| `waitFor` | pick list | `sync,health` | Comma-separated: `sync`, `health`, `operation`, `suspended`. |
| `timeoutSeconds` | int | `600` | |
| `failOnTimeout` | boolean | `true` | Off downgrades a timeout to "succeeded with issues". |
| `pollIntervalSeconds` | int | `5` | Jittered, to spread concurrent pipelines. |

`suspended` is for Argo Rollouts pause points: `Suspended` only counts as healthy when you
ask for it explicitly.

A **failed sync operation** stops the wait immediately — more waiting cannot help. `Degraded`
and `Missing` do **not** stop it, because both occur transiently during a normal rollout;
they fail the task by being the state at timeout.

### Status (`command: get` or `refresh`)

| Input | Type | Default | Notes |
|---|---|---|---|
| `refresh` | pick list | `none` | `get` only. `none`, `normal`, `hard`. |
| `hard` | boolean | `false` | `refresh` only. Also regenerate manifests. |
| `failOnHealth` | string | `Degraded,Missing` | Comma-separated statuses that fail the task. |
| `failOnOutOfSync` | boolean | `false` | Off reports "succeeded with issues". |

A refresh blocks server-side until the controller has reconciled, so it takes noticeably
longer than a plain read. The task allows for that with a larger HTTP timeout.

### Diff (`command: diff`)

| Input | Type | Default | Notes |
|---|---|---|---|
| `failOnDiff` | boolean | `false` | On makes the task a hard gate. |

The diff is rendered from Argo CD's normalized-live and predicted-live states — the same
comparison the UI shows — as a collapsible unified diff per changed resource.

### Output variables

| Variable | Set for |
|---|---|
| `syncStatus`, `healthStatus`, `revision` | Single-application runs |
| `operationPhase`, `operationMessage`, `appUrl` | Single-application runs |
| `appsJson` | Every run |
| `hasDiff`, `diffResourceCount` | `diff` |

Scalars are only set for single-application runs; a multi-application run would otherwise
publish whichever application happened to sort first. Use `appsJson` for those.

Give the step a `name` to reference them: `$(stepName.healthStatus)`.


### History and rollback (`command: history` or `rollback`)

| Input | Type | Default | Notes |
|---|---|---|---|
| `historyId` | string | `previous` | A history ID, or `previous` for the deployment before the current one. |
| `prune` | boolean | `false` | Shared with sync. |
| `dryRun` | boolean | `false` | Shared with sync; a dry run skips waiting. |

`history` reads `status.history[]` off the application — Argo CD has no history endpoint — and
publishes the newest ID as `latestHistoryId`. The list is capped by `spec.revisionHistoryLimit`
(default 10), so an empty result can mean "never synced" rather than "no data".

`previous` means the **second-newest** entry, not the oldest.

#### Automated sync blocks rollback

Argo CD refuses to roll back an application with automated sync enabled, because the controller
would immediately sync it forward again. The task detects this **before** making the request and
fails with an explanation. Either disable automated sync for the rollback, or revert in Git and
let Argo CD sync that — the GitOps-native route, and the one that leaves an audit trail.

### Resource actions (`command: action`)

| Input | Type | Default | Notes |
|---|---|---|---|
| `resource` | string | — | **Required.** `KIND:NAME`, `GROUP:KIND:NAME` or `GROUP:KIND:NAME:NAMESPACE`. |
| `action` | string | — | Action to run. **Leave empty to list what is available.** |
| `actionParameters` | multiline | — | One `name=value` per line. |

Argo CD exposes only a parameter's *name* — no type and no default — so values are passed
through as strings and cannot be validated up front.

An action runs a Lua script server-side and is **not transactional**: a failure partway through
can leave earlier changes applied. The API returns an empty body, so success means "accepted",
not "converged" — follow with `wait` if you need the latter.

### Manifests and logs (`command: manifests` or `logs`)

| Input | Type | Default | Notes |
|---|---|---|---|
| `manifestSource` | pick list | `git` | `git` renders desired state; `live` reads current cluster state. |
| `revision` | string | — | `git` only — live state has no revision to select. |
| `resource` | string | — | `logs`: narrow to one resource. Omit to stream every pod. |
| `podName` | string | — | `logs`: one pod. Do not combine with `resource`. |
| `container` | string | — | `logs` |
| `tailLines` | int | `1000` | `logs`: applied **per pod**, not overall. |
| `sinceSeconds` | int | — | `logs` |
| `previous` | boolean | `false` | `logs`: the previous container instance, for crash loops. |
| `logFilter` | string | — | `logs`: substring match; prefix `!` to invert. |
| `artifactName` | string | — | Defaults to `argocd-manifests` / `argocd-logs`. |

Both write full output to a file, publish it as a pipeline artifact, and echo a bounded tail to
the log. Outputs: `manifestCount`/`manifestFile`, `logLineCount`/`logFile`.

**Logs need the separate `logs` RBAC resource** — a token that can read applications may still be
denied logs. The task names that explicitly on a 403. Following is deliberately unsupported: a
following stream never terminates, and a task that never returns is worse than bounded output.

### Create (`command: create`)

| Input | Type | Default | Notes |
|---|---|---|---|
| `manifestFile` | path | — | **Required.** YAML or JSON; multi-document YAML supported. |
| `upsert` | boolean | `false` | Update if it already exists. |
| `validate` | boolean | `true` | Validate against the repository and destination before storing. |

Creating an application identical to an existing one is idempotent. Creating a *different* one
without `upsert` is rejected. Note `upsert` additionally requires **`update`** RBAC, not just
`create`, so a create-only token fails at that point rather than up front.

Outputs `appName` (single-application runs) and `createdCount`.

### Changing the spec (`command: set` or `unset`)

| Input | Type | Notes |
|---|---|---|
| `helmParameters` | multiline | `name=value` per line; upserts by name. **Unset takes names only.** |
| `helmStringParameters` | multiline | As above, forcing string values. |
| `helmValueFiles` | multiline | **Replaces the whole list**, matching `argocd app set --values`. |
| `kustomizeImages` | multiline | `name:tag`, `old=new:tag` or `name@sha256:…`. Merges by name. |
| `targetRevision` | string | `set` only. |
| `sourcePosition` | int | Multi-source apps, **numbered from 1**. Required when an app has several sources. |

#### This drifts from Git

`set` changes the **live** spec, so the cluster ends up ahead of Git. Argo CD will report the
application OutOfSync until the change is committed, or silently revert it if self-heal is
enabled. The task warns every run. Committing to the GitOps repository and syncing is the
durable alternative.

#### Kustomize image merging

Images merge on a key: everything before the first delimiter, checked in the order `=`, `:`, `@`.
So `nginx:1.2` and `nginx:1.3` share the key `nginx` and replace one another in place.

One upstream quirk is reproduced faithfully: because `:` is checked before `@`, a digest image
keys on `name@sha256`, not `name`. Two digests replace one another, but moving an image from a
tag to a digest **appends** rather than replacing. Diverging here would make this disagree with
the `argocd` CLI acting on the same application.

#### No optimistic concurrency

`PUT /spec` carries no resourceVersion, so the server does last-write-wins. Two pipelines editing
one application concurrently will clobber each other — that is an upstream property, not
something the task can fix.

#### There is no `image` command

Bump a Kustomize image with `kustomizeImages`, or a Helm chart's image tag with `helmParameters`.
A dedicated `image` command would have to guess the source type, and silently writing the wrong
spec field looks exactly like success.

### Delete (`command: delete`)

| Input | Type | Default | Notes |
|---|---|---|---|
| `confirm` | boolean | `false` | **Required.** The task refuses without it. |
| `cascade` | boolean | `true` | Also delete the managed resources. |
| `propagationPolicy` | pick list | default | `foreground` or `background`. Cannot be combined with `cascade: false`. |

Three guards, and the task fails **before** making any request when one trips:

1. **Label selectors are refused.** Applications must be named explicitly — a mistyped selector
   could otherwise cascade into mass deletion. Use `ArgoCDCli@1` if you genuinely need it.
2. **`confirm: true` is required.** The Argo CD API has no confirmation parameter at all; the
   CLI's `--yes` is purely client-side, so this guard is entirely the task's.
3. **`cascade: false` plus a propagation policy is rejected**, matching the server.

Deletion is **asynchronous**: the call returns once the finalizer is set, and resources disappear
as the controller reaps them. Outputs `deletedCount`.

### Terminate (`command: terminate`)

Cancels an in-flight operation, or reports that there was none. Publishes `terminatedCount`.

---

## ArgoCDInstall@1

Downloads, verifies and caches the `argocd` CLI, then adds it to `PATH` for later steps.

| Input | Type | Default | Notes |
|---|---|---|---|
| `version` | pick list | `server` | `server`, `latest`, or an explicit version such as `v3.5.3`. |
| `connection` | connection | — | Required only when `version` or `source` is `server`. |
| `source` | pick list | `auto` | `auto`, `github` or `server`. |
| `verifyChecksum` | boolean | `true` | Verify GitHub downloads against `cli_checksums.txt`. |

**Outputs:** `argocdPath`, `argocdVersion`.

### Where the binary comes from

`server` asks the Argo CD server for its own binary. That guarantees a version match and needs
no GitHub egress, but the server only serves a **Linux** binary for its **own architecture** —
it simply re-serves the `argocd` on its own `$PATH`. There is no macOS or Windows route.

`auto` therefore uses the server only when the agent is Linux and the architectures match, and
falls back to GitHub otherwise, saying which it chose and why.

### Checksums

GitHub downloads are verified against `cli_checksums.txt` and **fail on mismatch**. This is not
belt-and-braces: the underlying downloader treats a `Content-Length` mismatch as a warning, so
a truncated 250 MB download would otherwise be cached and fail much later as `exec format
error`.

Server downloads skip verification, because the server serves its own build — which for a
vendor or development build legitimately differs from the published release.

### Caching and cost

The binary is ~250 MB and the tool cache only persists on **self-hosted** agents. On
Microsoft-hosted agents it is downloaded every run. Set the pipeline variable
`ARGOCD_CLI_MIRROR` to an internal mirror (`<base>/releases/download/<tag>/<asset>`) to keep
that off the public internet, or use `ArgoCDApp@1` where you can.

### When the server version has no release

A server running a release candidate, a development build or a vendor distribution reports a
version with no matching GitHub release. The task says so and suggests pinning an explicit
version, rather than surfacing a bare 404.

---

## ArgoCDCli@1

Runs any `argocd` command with the connection's server and token injected. Requires the CLI on
`PATH` — add `ArgoCDInstall@1` first.

| Input | Type | Default | Notes |
|---|---|---|---|
| `connection` | connection | — | **Required.** |
| `arguments` | multiline | — | **Required.** Arguments for one `argocd` invocation, without `argocd` itself. |
| `workingDirectory` | path | — | Needed for commands reading local files, e.g. `app diff --local`. |
| `grpcWeb` | boolean | `false` | Pass `--grpc-web` when the ingress lacks end-to-end HTTP/2. |
| `failOnNonZeroExit` | boolean | `true` | Off reports "succeeded with issues" instead. |
| `failOnStderr` | boolean | `false` | Off by default: `argocd` writes progress to stderr. |

**Output:** `argocdExitCode`.

### One invocation per step

`arguments` is a single `argocd` command. Newlines are folded into one command line so long
commands stay readable, and a line starting with `#` is a comment. For several commands, use
several steps — that keeps `argocdExitCode` unambiguous.

```yaml
- task: ArgoCDCli@1
  inputs:
    connection: 'argocd-prod'
    arguments: |
      # preview what the local manifests would change
      app diff payments-api
      --local ./manifests
    workingDirectory: '$(Build.SourcesDirectory)'
```

### How the token is handled

The token is placed **only** in the CLI process's environment, as `ARGOCD_AUTH_TOKEN`. It is
never put on the command line, because some operating systems log process arguments, and never
exported as a pipeline variable, which would make it readable by every later step in the job.

Connection settings become ordinary argv flags (`--insecure`, `--grpc-web-root-path`,
`--server-crt`) rather than `ARGOCD_OPTS`, which the CLI parses during start-up and which
aborts the process outright if it cannot be parsed.

The CLI config directory is per-step and deleted afterwards, along with any temporary CA file,
so a cached session cannot leak between steps.


---

## ArgoCDProject@1

Read Argo CD projects and manage project role tokens. Its main job is rotating the credential your
pipelines authenticate with — see [Token rotation](token-rotation.md).

| Input | Type | Default | Notes |
|---|---|---|---|
| `command` | pick list | `list` | `list`, `get`, `list-tokens`, `create-token`, `delete-token`. |
| `project` | string | — | The AppProject. Required for everything but `list`. |
| `role` | string | — | Role within the project, for the token commands. |
| `expiresIn` | string | `90d` | Seconds, or a number with a unit (`s`, `m`, `h`, `d`, `w`). |
| `tokenId` | string | — | Token to revoke, from `create-token` or `list-tokens`. |

**Outputs:** `token` (secret), `tokenId`, `tokenCount`, `tokenIds`, `projectCount`, `roleCount`.

### The token is only retrievable once

Argo CD does not store the token value — the creation response is the only time you see it. It is
masked with `##vso[task.setsecret]` before anything can print it, then published as a **secret**
output variable.

Neither token-creation endpoint returns the id it assigned, so the task generates a UUID and sends
it as the id. That means `tokenId` is known without decoding the JWT, and revocation is a
straightforward `delete-token`.

### `expiresIn: 0` means never

A token with no expiry is hard to account for. The task warns when you ask for one, and the
duration parser **rejects** anything it cannot read rather than falling back to `0` — a lenient
parser would silently mint a permanent credential from a typo.

### Deleting verifies

The project token-deletion endpoint returns HTTP 200 even when it deleted nothing — a wrong role
name or a missing id both look like success. The task re-reads the project afterwards and fails if
the token is still there, rather than reporting a revocation that never happened.

---

## ArgoCDAccount@1

Manage local account tokens, and check what a token is permitted to do.

| Input | Type | Default | Notes |
|---|---|---|---|
| `command` | pick list | `can-i` | `can-i`, `list`, `get`, `create-token`, `delete-token`. |
| `account` | string | — | Local account name. |
| `expiresIn` | string | `90d` | As above. |
| `tokenId` | string | — | Token to revoke. |
| `resource` | pick list | `applications` | `can-i`: the RBAC resource. |
| `action` | pick list | `sync` | `can-i`: the RBAC action. |
| `subresource` | string | — | `can-i`: e.g. `payments/payments-api` or `payments/*`. |
| `failIfDenied` | boolean | `false` | `can-i`: fail the task when the answer is no. |

**Outputs:** `token` (secret), `tokenId`, `tokenCount`, `tokenIds`, `accountCount`, `allowed`.

### Prefer a project role token

An account token is scoped by whatever `policy.csv` grants it, which usually spans projects. When
one project is enough, [`ArgoCDProject@1`](#argocdproject1) is the better tool — its blast radius
is that project alone.

### The account needs `apiKey`

Token creation requires the account to have the `apiKey` capability, configured in `argocd-cm`:

```yaml
accounts.ado-ci: apiKey
```

That is server configuration and cannot be set through the API. The task maps the (otherwise
opaque) server error to this explanation.

### Asserting permissions early

`can-i` answers "may this token do X?" without attempting it, which makes it a cheap assertion at
the top of a pipeline:

```yaml
- task: ArgoCDAccount@1
  inputs:
    connection: 'argocd-prod'
    command: 'can-i'
    resource: 'applications'
    action: 'sync'
    subresource: 'payments/*'
    failIfDenied: true
```

Note that reading pod logs needs the separate `logs` RBAC resource, not `applications` — a token
that can sync may still be denied logs.

---

## ArgoCDAppSet@1

Manage ApplicationSets and preview what they generate.

| Input | Type | Default | Notes |
|---|---|---|---|
| `command` | pick list | `list` | `list`, `get`, `generate`, `create`, `delete`. |
| `name` | multiline | — | ApplicationSet name. For `delete`, one per line. |
| `manifestFile` | path | — | `create` and `generate` from a file. Multi-document YAML supported for `create`. |
| `generateFrom` | pick list | `file` | `file` previews a manifest; `name` previews the live ApplicationSet. |
| `upsert` | boolean | `false` | `create`. Requires `update` RBAC as well as `create`. |
| `dryRun` | boolean | `false` | `create`. Validates without persisting. |
| `projects` | multiline | — | `list` filter. |
| `selector` | string | — | `list` filter. **Not accepted for delete.** |
| `confirm` | boolean | `false` | **Required for delete.** |
| `appsetNamespace` | string | — | For appsets-in-any-namespace installs. |
| `artifactName` | string | — | `generate`. Defaults to `argocd-generated-apps`. |

**Outputs:** `appSetCount`, `appSetNames`, `generatedAppCount`, `generatedApps`,
`generatedAppsFile`, `deletedCount`.

### `dryRun` is not `generate`

They sound interchangeable and answer different questions:

- **`create` with `dryRun: true`** returns the ApplicationSet with its resource list populated —
  *what would this ApplicationSet own?* Nothing is persisted.
- **`generate`** returns the rendered Application objects — *what would it produce?*

For a pull request preview, you want `generate`.

### Where the generated Applications go

`generatedApps` is a **compact** JSON array of `{name, namespace, project, server}` — small enough
for a pipeline variable and usually all a downstream step needs. The **full** Application objects
are written to a file and published as an artifact, with the path in `generatedAppsFile`.

That departs from the PRD's `GENERATED_APPS_JSON`: full objects for an ApplicationSet generating
fifty applications run to hundreds of kilobytes, which is not what output variables are for.

### Deleting cascades

Deleting an ApplicationSet also deletes **every Application it generated**, and the cluster
resources those Applications manage, unless `spec.syncPolicy.preserveResourcesOnDeletion` is set.

So `delete` carries the same guards as `ArgoCDApp@1`'s: **explicit names only** — no label
selectors — plus `confirm: true`, both checked before any request is made. The task also reads the
ApplicationSet first and reports how many Applications are about to go with it, or that they will
be preserved.

### An empty list is ambiguous

Project filtering happens after the RBAC check, so an empty `list` result can mean either "nothing
matched" or "this token cannot see them". The task says so rather than implying none exist.
