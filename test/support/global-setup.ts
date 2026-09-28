// Build the task bundles ONCE, before any test worker starts.
//
// Several suites read dist/ -- the e2e harness spawns the bundles, and bundle-hygiene
// enumerates them to generate its cases. Building from each file's beforeAll was wrong in
// two ways that both went unnoticed because a developer's dist/ is usually already fresh:
//
//  1. RACE. vitest runs files in parallel workers. On a clean checkout several of them
//     found dist/ stale and each spawned scripts/build.mjs, so a worker could spawn a
//     bundle another worker was midway through writing. That surfaced in CI as a task
//     producing completely empty stdout, and nowhere else.
//  2. TOO LATE. `it.each(builtTasks())` is evaluated when the module is COLLECTED, which
//     happens before any beforeAll runs. With dist/ missing the read threw and the file
//     contributed no tests; with dist/ present but half-built it generated a subset -- and
//     an empty `it.each` is a silently PASSING file. The bundle-hygiene guards could
//     disappear from the run entirely and CI stayed green.
//
// globalSetup runs once, in its own process, before collection. Per-file ensureBuilt()
// calls then see a fresh bundle and return immediately.

import { ensureBuilt } from './run-task';

export default function setup(): void {
    ensureBuilt();
}
