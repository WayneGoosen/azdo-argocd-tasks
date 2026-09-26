# Zero-secret auth via Dex token exchange — research spike

**Verdict: GO, pending one live test.** Every checkable link in the chain verifies. Nothing is
implemented in the extension — this document exists so the decision is made on evidence rather
than on the PRD's original "plausible but unverified".

**Read the [longevity warning](#the-real-risk-is-temporal-not-technical) before acting on this.**

## The idea

Instead of storing a long-lived Argo CD token in a service connection, a pipeline mints a
short-lived Azure DevOps OIDC token at run time and exchanges it — through Argo CD's bundled Dex —
for an Argo CD credential. No secret at rest.

Argo CD documents this for GitHub Actions and GitLab CI. It does **not** document it for Azure
DevOps, and as far as this research could establish **nobody has attempted it**. That is "unproven",
not "known broken".

## What verifies

| Link | Status |
|---|---|
| `POST /api/dex/token` exists and is reverse-proxied to Dex with no path allowlist | Verified in source |
| The `argo-cd-cli` public client is created unconditionally | Verified in source |
| Argo CD 3.4+ bundles Dex 2.45.0; RFC 8693 token exchange landed in Dex 2.38.0 | Verified |
| Dex sets `SkipClientIDCheck: true` when verifying an exchanged ID token | Verified in source |
| Azure DevOps serves OIDC discovery with a public RS256 JWKS | Verified by live probe |
| The discovery document's `issuer` echoes the org GUID back | Verified by live probe |
| Azure DevOps mints tokens via a documented REST API, for third-party connection types | Verified / strongly inferred |

Two findings matter more than the rest:

**The audience is a non-issue.** Azure DevOps tokens carry a fixed, non-configurable
`aud: api://AzureADTokenExchange`. That looked like the most likely blocker. It is not: Dex's OIDC
connector sets `SkipClientIDCheck: true` on the token-exchange path, so `aud` is never checked.
What *is* checked is the RS256 signature against the JWKS, an exact `iss` match, and `exp`/`nbf`.

**Discovery works, which was the crux.** go-oidc hard-fails unless the discovery document's
`issuer` equals the configured URL. Probing `https://vstoken.dev.azure.com/<org-GUID>/.well-known/openid-configuration`
returns a valid document whose `issuer` echoes the GUID, with a public, org-independent
`jwks_uri`. No `issuerAlias` workaround is needed. AWS corroborates this independently — their
Azure DevOps federation guide has you register the same URL as an IAM OIDC provider, which
requires resolvable discovery.

## The connector

Azure DevOps tokens carry **no `name` and no `email` claim**, and Dex's OIDC connector requires
both by default. The configuration must suppress that:

```yaml
# argocd-cm
dex.config: |
  connectors:
    - type: oidc
      id: azure-devops
      name: Azure DevOps
      config:
        issuer: https://vstoken.dev.azure.com/<your-org-GUID>
        clientID: api://AzureADTokenExchange
        # Azure DevOps tokens have no name or email claim.
        scopes:
          - openid
        userNameKey: sub
        insecureSkipEmailVerified: true
```

RBAC then matches on the token's `sub`, which is `sc://<org>/<project>/<service-connection-name>`:

```
# argocd-rbac-cm
p, sc://contoso/payments/argocd-prod, applications, sync, payments/*, allow
```

## The exchange

```bash
# 1. Mint an Azure DevOps OIDC token (inside a pipeline).
OIDC=$(curl -sSf -X POST \
  "$(System.OidcRequestUri)?serviceConnectionId=<id>&api-version=7.1-preview.1" \
  -H "Authorization: Bearer $(System.AccessToken)" \
  -H 'Content-Length: 0' | jq -r .oidcToken)

# 2. Exchange it for an Argo CD credential.
ARGOCD_AUTH_TOKEN=$(curl -sSf "https://argocd.example.com/api/dex/token" \
  --user argo-cd-cli: \
  --data-urlencode "connector_id=azure-devops" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  --data-urlencode "scope=openid email profile federated:id" \
  --data-urlencode "requested_token_type=urn:ietf:params:oauth:token-type:access_token" \
  --data-urlencode "subject_token=$OIDC" \
  --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:id_token" \
  | jq -r .access_token)
```

The `federated:id` scope is required — without it the upstream `sub` is not carried through and
RBAC cannot match on it.

## The one untested step

Azure DevOps' discovery document advertises only `response_types_supported: ["id_token"]` and
**omits `authorization_endpoint` and `token_endpoint`**. Dex's `Config.Open()` calls
`provider.Endpoint()` and builds an `oauth2.Config` unconditionally. Reading the code, nothing
validates those fields, so `Open()` should succeed with empty endpoints and the connector will work
for token exchange while its browser-login button stays dead.

That is inferred from source, not observed. It is the one genuinely untested link.

### Live test, about 30 minutes

1. `curl` the discovery URL with your real org GUID; confirm `issuer` echoes it.
2. Mint a token against a workload-identity service connection; decode it; confirm `iss`, `aud`, `sub`.
3. Add the connector to `argocd-cm` and **watch `argocd-dex-server` logs for a successful `Open()`**
   despite the missing `authorization_endpoint`. *This is the step that decides it.*
4. Run the exchange above; confirm `argocd account get-user-info` returns your `sc://…` subject.
5. Optional, cheap, potentially valuable: repeat step 2 with `serviceConnectionId` omitted and
   inspect the resulting `sub`. If it yields a pipeline-scoped subject, the service-connection
   requirement disappears entirely.

Argo CD 3.4's `dexserver.connector.failure.continue` (on by default) limits the blast radius if
step 3 fails — a broken connector will not take the server down.

## The real risk is temporal, not technical

**The `vstoken.dev.azure.com` issuer is deprecated as of 1 July 2026 and retires 1 July 2027.**
New service connections already default to the Microsoft Entra issuer,
`https://login.microsoftonline.com/`.

When that flips, **two things change at once**:

- the connector's `issuer` must be reconfigured, and
- **the `sub` format changes** — Entra uses an immutable GUID subject, not
  `sc://<org>/<project>/<connection>`.

Every `policy.csv` line written against the old subject format silently stops matching. For an
extension with a multi-year support horizon, shipping an auth mode whose identity format is
scheduled to change underneath it is a worse problem than any of the protocol questions above.

That is why this is documented as a recipe rather than built as a supported `authMode`.

## If it does not work

**Pointing `oidc.config` directly at Entra ID does not help.** Argo CD's native OIDC config is a
*login* flow; it does not accept a foreign JWT as a bearer token. Dex token exchange is the
mechanism, not one option among several.

**`argocd --core` over an AKS workload-identity connection is the realistic fallback.** An Azure
Resource Manager WIF service connection → `az aks get-credentials` → `ArgoCDCli@1` with `--core`
talks to the Kubernetes API directly against Application CRs. Genuinely zero stored secrets, on the
boring supported path. The cost is that authorization becomes Kubernetes RBAC rather than Argo CD
RBAC, so AppProject roles no longer apply, and `--core` cannot do everything the API can.

## Recommendation

Keep the project role token as the default, as it is today. Treat this as an opt-in recipe for
teams willing to run the live test. Revisit as a supported auth mode only once the Entra issuer
migration has landed and the subject format is stable — otherwise the feature ships with a known
expiry date.

## Sources

- [Argo CD — GitHub Actions token exchange](https://github.com/argoproj/argo-cd/blob/master/docs/operator-manual/user-management/github-actions.md)
- [Argo CD — GitLab CI token exchange](https://github.com/argoproj/argo-cd/blob/master/docs/operator-manual/user-management/gitlab-ci.md)
- [Dex — Token exchange guide](https://dexidp.io/docs/guides/token-exchange/) · [OIDC connector source](https://github.com/dexidp/dex/blob/master/connector/oidc/oidc.go) · [v2.38.0 release](https://github.com/dexidp/dex/releases/tag/v2.38.0)
- [Microsoft Learn — Oidctoken Create](https://learn.microsoft.com/en-us/rest/api/azure/devops/distributedtask/oidctoken/create?view=azure-devops-rest-7.1)
- [Azure DevOps Blog — Retirement of the Azure DevOps issuer in WIF service connections](https://devblogs.microsoft.com/devops/retirement-of-azure-devops-issuer-in-workload-identity-federation-service-connections/)
- [AWS — Federating into AWS from Azure DevOps using OIDC](https://aws.amazon.com/blogs/modernizing-with-aws/how-to-federate-into-aws-from-azure-devops-using-openid-connect/)
- [Argo CD — Discussion #25005, external OIDC tokens](https://github.com/argoproj/argo-cd/discussions/25005)
