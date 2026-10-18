---
applyTo: "tasks/**"
---

# Pipeline tasks

Each `tasks/ArgoCD*V1/` directory is a shipped Azure Pipelines task.
`task.json` is the public contract; `index.ts` is the agent entry point.

## What a real failure looks like

- **Dropped `run()`.** The entry point is `async function run()` and
  **must** be invoked as `void run()`. A floating promise means the
  agent reports success after a throw. House rule: validate, then
  `setResult(Failed)`, then `return`. `run()` never throws.
- **Task major bumped in place.** Pipelines pin `ArgoCDApp@1`. Changing
  `task.json` `version.Major` rewrites that reference for every consumer.
  A breaking change is a new `tasks/ArgoCDAppV2/` directory shipped
  *alongside* V1. `stamp-version.mjs` will refuse a mismatched major.
- **`Node20_1` removed or CI Node raised.** Both `Node20_1` and `Node24`
  handlers must stay. The bundle is esbuild `target: 'node20'`. Do not
  drop `Node20_1` until Azure DevOps removes Node 20 from agents
  (see `STATUS.md`).
- **Secret written to a file.** Use `registerSecret` from task-common,
  never `tl.setSecret` alone. The run attachment is `writeFileSync` plus
  upload; `tl.setSecret` only masks the log stream.
- **Spec reconstructed on `set` / `unset`.**
  `PUT /applications/{name}/spec` is a full replace. Mutate the parsed
  object in place (`packages/task-common/src/spec-mutation.ts`).
- **Input / output names with underscores.** The schema is
  `^[A-Za-z][A-Za-z0-9]*$`. Use camelCase.
- **`getBoolInput` for a default-true flag.** The agent applies defaults,
  not task-lib. `getBoolInput` returns `false` when the input is absent,
  inverting a declared `true`. Use `getBoolInputOrDefault`.
- **Request without `project`.** Argo CD returns `permission denied` for
  both a missing app and an RBAC miss. Always send `project`.

Bundle with **esbuild**, not webpack. Do not `require` anything at
runtime that is not a Node builtin — CI asserts the bundle is complete
and that `azure-pipelines-task-lib` appears exactly once.
