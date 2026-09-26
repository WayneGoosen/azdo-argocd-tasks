# Security guide

## Choosing a credential

| Credential | Blast radius | Use it for |
|---|---|---|
| **Project role token** (recommended) | One AppProject | Ordinary application sync, wait, diff |
| **Local account API token** (`apiKey`) | Whatever `policy.csv` grants | Steps that must cross projects |
| Admin session JWT | Everything | Never in a pipeline |

Create a project role token:

```sh
argocd proj role create-token payments ado-ci --expires-in 90d
```

Paste it into the **API token** field of an Argo CD service connection. Sample manifests for
both credential types are in [`samples/rbac`](https://github.com/WayneGoosen/azdo-argocd-tasks/blob/main/samples/rbac).

## Least-privilege RBAC

Start from `policy.default: ''` so authenticated users get nothing implicitly, then grant
exactly what the pipeline needs:

```
p, proj:payments:ado-ci, applications, get,  payments/*, allow
p, proj:payments:ado-ci, applications, sync, payments/*, allow
```

Verify it rather than assuming:

```sh
argocd admin settings rbac can ado-ci sync applications payments/payments-api
```

Two things that catch people out:

- **Argo CD 3.0 made RBAC fine-grained.** `update` or `delete` on an Application no longer
  implies the same on its sub-resources. A pipeline that restarts a Deployment needs an
  explicit `action/apps/Deployment/restart` grant.
- **An explicit `deny` wins over any later `allow`**, which makes it a good way to keep
  production deletes off the table entirely.

One identity per pipeline gives you a real audit trail: Argo CD attributes every action to
the role subject in API-server logs.

## How the token is handled

- Masked with `##vso[task.setsecret]` the instant it is read, before any request is made.
  The end-to-end test asserts this ordering and that the raw token never appears later in
  the log.
- Sent only in an `Authorization: Bearer` header — never on a command line, where it would
  be visible in process listings.
- Never written to the run summary, output variables or the task result message.

## Checking permissions

`ArgoCDAccount@1`'s `can-i` command answers "may this token do X?" without attempting it, which
makes it a cheap early assertion in a pipeline:

```sh
argocd account can-i sync applications 'payments/payments-api'
```

Note the RBAC resource list is fixed: `applications`, `applicationsets`, `projects`,
`repositories`, `write-repositories`, `clusters`, `accounts`, `certificates`, `gpgkeys`, `logs`,
`exec`, `extensions`. Reading pod logs needs `logs`, which is separate from `applications`.

## Rotation

Project role tokens expire, and a pipeline that fails at 2am because a token lapsed is a bad
way to find out. Rotate on a schedule:

```sh
# Mint the replacement, update the service connection, then revoke the old one.
argocd proj role create-token payments ado-ci --expires-in 90d
argocd proj role list-token-ids payments ado-ci
argocd proj role delete-token payments ado-ci <old-jwt-id>
```

Revocation is immediate — deleting the JWT ID from the role invalidates the token without
touching the account or the policy.

`ArgoCDProject@1` and `ArgoCDAccount@1` automate the minting and revoking. The full runbook,
including the service-connection update and why it is a documented step rather than a task, is in
[token-rotation.md](token-rotation.md).

## TLS

Prefer supplying your internal CA in the **Custom CA certificate** field over enabling
**Skip TLS verification**. Skipping verification still encrypts traffic but stops verifying
who is on the other end, which defeats most of the point; the task emits a warning whenever
it is enabled.

## Network reachability

The tasks run on your agent, so Argo CD only has to be reachable from the agent — a private
ingress or in-cluster service URL is fine.

The one exception is the service connection's **Verify** button, which is evaluated by the
Azure DevOps service itself rather than by an agent. It will fail for a private Argo CD even
though pipelines work perfectly. The same caveat applies to Environment "Invoke REST API"
checks.
