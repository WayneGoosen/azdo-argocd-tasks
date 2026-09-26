# Rotating the Argo CD token

The token in your Argo CD service connection expires. When it does, every pipeline using it fails
at once, usually at an inconvenient hour. This is how to rotate it on a schedule instead.

The shape is always the same:

1. **Mint** a new token.
2. **Update** the service connection with it.
3. **Revoke** the old one.

In that order. Revoking first means a window where nothing works; updating before minting means
there is nothing to update to.

## Which credential

| | Use when | Rotate with |
|---|---|---|
| **Project role token** | One AppProject is enough — the common case | `ArgoCDProject@1` |
| **Local account token** | The pipeline must cross projects | `ArgoCDAccount@1` |

Prefer the project role token. Its blast radius is a single project, and it is revoked by deleting
one ID from one role.

## The chicken-and-egg problem

Rotating a credential requires a credential. The rotation pipeline needs a token that may
`update` the project (or account) — which is *not* the same token it is rotating, and should not
be. Use a separate, longer-lived **rotation** connection that can do nothing but manage tokens:

```
# argocd-rbac-cm
p, role:token-rotator, projects, get,    payments, allow
p, role:token-rotator, projects, update, payments, allow
g, ado-token-rotator, role:token-rotator
```

That account can mint and revoke, and cannot sync, read or delete anything. It is the only
credential you rotate by hand.

## Step 2 is not a task

Updating a service connection means calling the Azure DevOps REST API, which is a different API
with different auth from everything else this extension does. It is deliberately **not** wrapped in
a task: a half-tested credential-rotation task is worse than a documented step you can read.

The endpoint is
`PUT https://dev.azure.com/{org}/{project}/_apis/serviceendpoint/endpoints/{id}?api-version=7.1`,
and it is a **full replace** — GET the endpoint first, change only
`authorization.parameters.apitoken`, and PUT the whole object back.

The pipeline identity needs **Administrator** on that service connection, and the build service
account must be granted it explicitly.

## Verify, then revoke

Do not revoke the old token because the update returned 200. Prove the new one works first — the
sample below uses `ArgoCDAccount@1`'s `can-i` for exactly this. If verification fails, the old
token is still valid and nothing is broken.

## Schedule it

Run it at **half** the token lifetime. A 90-day token rotated every 45 days gives a full cycle of
slack to notice a failure:

```yaml
schedules:
  - cron: '0 3 1 */1 *'      # 03:00 on the 1st of each month
    displayName: Monthly token rotation
    branches: { include: [main] }
    always: true
```

Alert on failure. A rotation pipeline that fails silently is worse than no rotation pipeline,
because it creates the false belief that rotation is handled.

## The sample

[`samples/pipelines/rotate-token.yml`](https://github.com/WayneGoosen/azdo-argocd-tasks/blob/main/samples/pipelines/rotate-token.yml) implements all of
this. Read it before running it — it changes a credential your other pipelines depend on.

## Going further

[The Dex token exchange spike](dex-token-exchange.md) explores removing the stored token entirely, by exchanging a
short-lived Azure DevOps OIDC token for an Argo CD credential at run time. The verdict is "viable,
pending one live test", with a significant caveat about the Azure DevOps issuer retiring in 2027.
