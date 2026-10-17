---
applyTo: "tab/**"
---

# Build-results tab

The tab is a separate compilation unit (`tsconfig.tab.json`, DOM lib, ESM)
bundled by **webpack**. esbuild cannot consume `azure-devops-extension-api`
(AMD-only). "Simplifying" to one bundler ships a blank iframe.

## What a real failure looks like

- **`innerHTML` / `outerHTML` / `document.write`.** The tab renders
  application names, diffs, and health from the cluster under a strict
  host CSP. String-assembled markup is an XSS vector. Build every node
  with `createElement` and `textContent`. ESLint
  `no-restricted-properties` is the backstop, not the review.
- **Two SDK copies.** The api package's AMD modules can resolve
  `azure-devops-extension-sdk` to a different file than our ESM import.
  Two instances trip "already loaded" and `SDK.init()` never resolves —
  the tab sits on its loading state with nothing logged. Keep the
  `azure-devops-extension-sdk$` webpack alias.
- **Treating `SDK.getService()` as sync.** Everything from that call is
  an XDM proxy; methods **always** return a Promise even when the `.d.ts`
  says otherwise. Await `unknown` returns (see `tab/model.ts`). Removing
  an "unnecessary" await shipped 1.0.15 as "could not identify the build".
- **`dist/tab` not addressable, or missing from the VSIX.** The iframe
  404s to a blank page. `pr.yml` asserts `dist/tab/tab.html|js|css` are
  inside the package.

`supportsTasks` GUIDs are hand-copied from each `task.json`. Drift
silently hides the tab. `test/manifest/extension-manifest.test.ts`
guards it — do not "clean up" a GUID that looks unused.
