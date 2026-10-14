# Contributing to Argo CD Pipeline Tasks

Thank you for your interest in contributing! This guide will help you get set up, run tests, and contribute code.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** >= 20 (see [`.nvmrc`](.nvmrc))
- **Docker** (for integration tests)
- **kind** ([installation guide](https://kind.sigs.k8s.io/docs/user/quick-start/#installation))
- **kubectl** ([installation guide](https://kubernetes.io/docs/tasks/tools/))
- **argocd CLI** ([installation guide](https://argo-cd.readthedocs.io/en/stable/cli_installation/))

If you use `nvm`, simply run:

```bash
nvm install
```

## Getting Started

Clone the repository and install dependencies:

```bash
git clone https://github.com/WayneGoosen/azdo-argocd-tasks.git
cd azdo-argocd-tasks
npm ci
```

## Project Structure

The repository is organized as a npm workspace:

- **`packages/argocd-client/`** — Typed REST client for the Argo CD API (grpc-gateway), used by all tasks
- **`packages/task-common/`** — Shared runtime for the pipeline tasks: connection handling, error formatting, output variables, and run attachments
- **`packages/cli-runner/`** — Download, cache, and invoke the `argocd` CLI (used by `ArgoCDInstall@1` and `ArgoCDCli@1`)
- **`tasks/*/`** — The six pipeline tasks (`ArgoCDApp`, `ArgoCDAppSet`, `ArgoCDProject`, `ArgoCDAccount`, `ArgoCDInstall`, `ArgoCDCli`)
- **`scripts/`** — Build, version stamping, swagger vendoring, icon generation, and the kind harness
- **`test/`** — Unit, contract, end-to-end, and integration tests
- **`docs/`** — The MkDocs site published to [waynegoosen.github.io/azdo-argocd-tasks](https://waynegoosen.github.io/azdo-argocd-tasks/)

## Common Commands

### Typecheck

```bash
npm run typecheck         # Typecheck tasks and packages
npm run typecheck:tab     # Typecheck the Argo CD build tab (separate compilation unit)
```

### Lint

```bash
npm run lint              # Lint all code
npm run lint:fix          # Auto-fix linting issues
```

### Test

```bash
npm test                  # Run unit, contract, and end-to-end tests
npm run test:watch        # Run tests in watch mode
npm run test:coverage     # Run tests with coverage report
```

The test suite runs the real bundled artifacts against local replay servers, so bundling regressions are caught before packaging.

### Build

```bash
npm run build             # Full build: typecheck, bundle tasks with esbuild, bundle tab with webpack
npm run build:dev         # Development build with sourcemaps
```

### Package

```bash
npm run package           # Build and create a .vsix extension
npm run package:dev       # Build and create a dev .vsix with overrides from vss-extension.dev.json
```

## Integration Tests

Integration tests run against a real Argo CD instance. They are skipped by default unless `ARGOCD_TEST_SERVER` is set.

### Running Integration Tests Locally

1. **Start a local Argo CD cluster:**

   ```bash
   ./scripts/kind-argocd.sh 3.5.3
   ```

   This script creates a kind cluster, installs Argo CD, creates a test account, and sets up port forwarding.

2. **Source the environment and run the tests:**

   ```bash
   source .argocd-env && npx vitest run test/integration
   ```

The integration tests are run by CI across Argo CD 3.3, 3.4, and 3.5 (the versions upstream supports).

### Tearing Down

When you're done:

```bash
kind delete cluster --name argocd-test
```

## Tab Development Harness

The extension includes an Argo CD build results tab. You can develop and preview it locally:

```bash
npm run dev
```

This builds the tab, copies fixtures into `.dev/`, and starts a local HTTP server on port 8777. Open [http://localhost:8777/tab.html](http://localhost:8777/tab.html) to see the tab with fixture data.

Fixtures are in `dev-fixtures/` and represent the JSON attachments the tasks publish during a pipeline run.

## Testing in Your Own Azure DevOps Organization

To test your changes in a real Azure DevOps pipeline:

1. **Package a dev build:**

   ```bash
   npm run package:dev
   ```

   This creates a `.vsix` with a modified extension ID and endpoint type (defined in `vss-extension.dev.json`), so it won't collide with the published version.

2. **Install the private `.vsix`:**

   - Go to your Azure DevOps organization
   - Navigate to **Organization settings → Extensions → Upload**
   - Upload the `.vsix` from `dist/`
   - Share it with your project

3. **Create an Argo CD service connection:**

   - Go to **Project settings → Service connections → New service connection**
   - Select **Argo CD (Dev)** (the dev endpoint type)
   - Enter your Argo CD server URL and token

4. **Use the tasks in a pipeline:**

   Reference them with `@0` (the dev major version) instead of `@1`.

## Commit Style

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add support for X` — new features
- `fix: correct Y behavior` — bug fixes
- `docs: update Z` — documentation changes
- `chore: bump dependencies` — maintenance tasks
- `test: add coverage for W` — test additions

Use imperative mood ("add feature" not "adds feature" or "added feature").

## Pull Request Process

1. **Create a feature branch** from `main`
2. **Make your changes** and commit them using [Conventional Commits](#commit-style)
3. **Push your branch** to GitHub
4. **Open a pull request** against `main`. GitHub pre-fills the [pull request template](.github/pull_request_template.md) — complete the description, related issue, and checklist.

### What CI Checks

The `pr.yml` workflow runs on every pull request:

- **Typecheck** — both the tasks and the tab
- **Lint** — ESLint with typescript-eslint
- **Tests** — unit, contract, and end-to-end tests with coverage
- **Package** — ensures the `.vsix` builds successfully
- **Bundle hygiene** — verifies no unbundled runtime dependencies leaked into task bundles
- **Marketplace assets** — ensures required assets are present in the `.vsix` manifest

All checks must pass before a PR can be merged.

## Project Status and Roadmap

See [`STATUS.md`](STATUS.md) for:

- Current development focus and what's next
- Recently shipped features
- Known blockers and gotchas
- Deferred features with reasoning
- Dated commitments (e.g., when Argo CD versions roll off support)

`STATUS.md` is the single source of truth for this project's state.

## Questions or Issues?

- **Bug reports** — [open a bug report](https://github.com/WayneGoosen/azdo-argocd-tasks/issues/new?template=bug.yml) using the bug issue form
- **Feature requests** — [open a feature request](https://github.com/WayneGoosen/azdo-argocd-tasks/issues/new?template=feature.yml) using the feature issue form
- **Security vulnerabilities** — do not open a public issue; report privately following [`SECURITY.md`](SECURITY.md)
- **Documentation** — see the [published docs](https://waynegoosen.github.io/azdo-argocd-tasks/)

## License

By contributing, you agree that your contributions will be licensed under the [Apache-2.0 License](LICENSE).
