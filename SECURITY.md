# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in these Azure DevOps Argo CD tasks, please report it privately through GitHub's **private vulnerability reporting** feature rather than opening a public issue.

**To report a vulnerability:**

1. Go to the [Security tab](https://github.com/WayneGoosen/azdo-argocd-tasks/security) of this repository
2. Click "Report a vulnerability"
3. Fill in the details using the guidance below

We will acknowledge your report within **5 business days**.

## Supported Versions

We currently support security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## What to Include in Your Report

To help us understand and address the vulnerability quickly, please include:

- **Affected task**: Which task is impacted (e.g., `ArgoCDDeploy@1`, `ArgoCDAccount@1`, `ArgoCDProject@1`)
- **Argo CD version**: The version of Argo CD server you're using
- **Agent version**: The Azure DevOps agent version and OS
- **Reproduction steps**: Clear steps to reproduce the vulnerability
- **Impact**: Your assessment of the potential security impact

**Important:** Please **redact tokens, server URLs, and other secrets** from any logs, screenshots, or configuration examples before sharing them. Replace sensitive values with placeholders like `[REDACTED]` or `***`.

## Secure Usage Guidance

For guidance on using these tasks securely in your pipelines, including:
- Credential selection and least-privilege RBAC
- Token handling and rotation
- TLS configuration

Please refer to our [Security Guide](docs/security.md).

## Disclosure Policy

We ask that you:
- Give us reasonable time to investigate and address the vulnerability before public disclosure
- Make a good faith effort to avoid privacy violations, data destruction, and service disruption during your research

## Questions?

If you have questions about this policy or need to contact us for other security-related matters, please use GitHub's private vulnerability reporting feature.
