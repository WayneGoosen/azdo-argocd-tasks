# Creating the service connection with Terraform

The Argo CD service connection can be managed as code, including the token inside it. Done
properly, no human ever sees the credential: Terraform mints a project role token in Argo CD and
writes it straight into the Azure DevOps connection.

## Read this first

The Azure DevOps provider ships a resource called `azuredevops_serviceendpoint_argocd`. **It does
not work with this extension.**

It creates a connection of type `argocd`, which belongs to a different, older Marketplace
extension — its own documentation tells you to install that one. This extension's connection type
is **`argocdrest`**, because the `argocd` name was already claimed. Service endpoint type names
are global across the Marketplace and cannot be shared.

Use `azuredevops_serviceendpoint_generic_v2` and set the type explicitly.

## What you need

| | Version | Why |
|---|---|---|
| `microsoft/azuredevops` | **>= 1.12.0** | `azuredevops_serviceendpoint_generic_v2` was added in 1.12.0 |
| `argoproj-labs/argocd` | >= 7.0 | `argocd_project_token` — only needed if Terraform mints the token too |
| This extension | installed in the org | the connection type must exist before `plan` runs (see below) |

## The full example

Three things in sequence: an AppProject with a role scoped to what the pipeline may do, a token
bound to that role, and the Azure DevOps connection carrying it.

```hcl
terraform {
  required_providers {
    azuredevops = { source = "microsoft/azuredevops", version = "~> 1.12" }
    argocd      = { source = "argoproj-labs/argocd", version = "~> 7.0" }
  }
}

provider "argocd" {
  server_addr = "argocd.example.com:443"
  auth_token  = var.argocd_admin_token   # or username/password
}

provider "azuredevops" {
  org_service_url       = "https://dev.azure.com/my-org"
  personal_access_token = var.azdo_pat
}

# 1. The project, with a role granting exactly what the pipeline needs.
resource "argocd_project" "payments" {
  metadata {
    name      = "payments"
    namespace = "argocd"
  }

  spec {
    description  = "Payments services"
    source_repos = ["https://github.com/my-org/payments.git"]

    destination {
      server    = "https://kubernetes.default.svc"
      namespace = "payments"
    }

    role {
      name        = "ado-ci"
      description = "Azure Pipelines deploy identity"
      policies = [
        "p, proj:payments:ado-ci, applications, get,  payments/*, allow",
        "p, proj:payments:ado-ci, applications, sync, payments/*, allow",
      ]
    }
  }
}

# 2. The token. Terraform regenerates it before it expires.
resource "argocd_project_token" "ado_ci" {
  project      = argocd_project.payments.metadata[0].name
  role         = "ado-ci"
  description  = "Azure Pipelines — managed by Terraform"
  expires_in   = "2160h" # 90 days
  renew_before = "168h"  # regenerate with 7 days to spare

  lifecycle {
    create_before_destroy = true
  }
}

# 3. The Azure DevOps service connection.
resource "azuredevops_serviceendpoint_generic_v2" "argocd" {
  project_id           = azuredevops_project.payments.id
  name                 = "argocd-prod"
  description          = "Managed by Terraform"
  type                 = "argocdrest"
  server_url           = "https://argocd.example.com"
  authorization_scheme = "Token"

  authorization_parameters = {
    apitoken = argocd_project_token.ado_ci.jwt
  }

  parameters = {
    insecureSkipTlsVerify = "false"
    grpcWebRootPath       = ""
  }
}
```

The pipeline then refers to it by name, exactly as if you had created it by hand:

```yaml
- task: ArgoCDApp@1
  displayName: Deploy payments
  inputs:
    connection: 'argocd-prod'
    command: 'sync'
    applications: 'payments-api'
    project: 'payments'
```

## Which field goes where

The two maps are not interchangeable, and putting a value in the wrong one produces a connection
that saves without complaint and then fails at run time.

| Connection field | Terraform argument | Ends up in |
|---|---|---|
| API token | `authorization_parameters.apitoken` | `authorization.parameters` |
| Server URL | `server_url` | `url` |
| Custom CA certificate | `parameters.caCertificate` | `data` |
| Skip TLS verification | `parameters.insecureSkipTlsVerify` | `data` |
| Root path | `parameters.grpcWebRootPath` | `data` |

Use `authorization_scheme = "None"` with no `authorization_parameters` for the anonymous variant.

## Four things that catch people out

- **The argument is `type`, not `service_endpoint_type`.** The upstream example in the provider
  documentation uses the latter and does not work; the argument reference below that example is
  correct. Copy from here, not from there.
- **`parameters` is a map of strings.** `insecureSkipTlsVerify` must be `"false"`, quoted — not a
  bare boolean.
- **The extension must already be installed in the organisation.** `generic_v2` validates the type
  name, the auth scheme and every field id against the connection types the organisation actually
  has, at *plan* time. That catches typos early, but it does mean Terraform cannot install the
  extension and create the connection in the same run.
- **The token is in your state file, unencrypted.** `authorization_parameters` is marked sensitive
  so it stays out of plan output, and `argocd_project_token.jwt` likewise — but both are plaintext
  in state, as all Terraform secrets are. Use an encrypted remote backend.

## Rotation comes for free

[Rotating the token](token-rotation.md) by hand is three steps: mint, update the connection,
revoke the old one — in that order. The Terraform version collapses into one `apply`.

`renew_before` makes the token resource plan a replacement once its remaining lifetime drops below
the threshold. The new JWT flows into `authorization_parameters` in the same apply, so the
connection is updated in the same breath as the token is minted.

`create_before_destroy` in the example is doing real work. Terraform's default for a replacement is
destroy-then-create, which would revoke the working token *before* minting its successor — a window
where every pipeline fails. Creating first removes that window.

Run `terraform apply` on a schedule comfortably shorter than `renew_before` and the credential
rotates itself.

## Without the Argo CD provider

If the token is minted elsewhere — by `ArgoCDProject@1` in a rotation pipeline, or by hand — drop
the `argocd` provider and feed a variable in:

```hcl
variable "argocd_token" {
  type      = string
  sensitive = true
}

resource "azuredevops_serviceendpoint_generic_v2" "argocd" {
  # ...
  authorization_parameters = {
    apitoken = var.argocd_token
  }
}
```

## Without Terraform

`generic_v2` needs provider 1.12.0. If you are pinned below that, the connection is an ordinary
REST object:

```
POST https://dev.azure.com/{organization}/_apis/serviceendpoint/endpoints?api-version=7.1
```

```json
{
  "name": "argocd-prod",
  "type": "argocdrest",
  "url": "https://argocd.example.com",
  "data": {
    "insecureSkipTlsVerify": "false",
    "grpcWebRootPath": ""
  },
  "authorization": {
    "scheme": "Token",
    "parameters": { "apitoken": "<argocd-project-role-token>" }
  },
  "isShared": false,
  "serviceEndpointProjectReferences": [
    {
      "projectReference": { "id": "<project-guid>", "name": "MyProject" },
      "name": "argocd-prod"
    }
  ]
}
```

`serviceEndpointProjectReferences` is what attaches the connection to a project — the URL is
organisation-scoped, so without it the connection belongs nowhere.

The same document works with the Azure CLI, which passes it straight through:

```sh
az devops service-endpoint create \
  --service-endpoint-configuration ./argocd-endpoint.json \
  --org https://dev.azure.com/my-org --project MyProject \
  --query id -o tsv
```

Constrain the output. The command echoes the whole endpoint object back on stdout, and in a
pipeline that goes into the build log.

To confirm the type name and field ids against a live organisation:

```
GET https://dev.azure.com/{organization}/_apis/serviceendpoint/types?api-version=7.1-preview.1
```
