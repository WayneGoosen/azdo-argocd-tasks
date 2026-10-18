## Description
<!-- Provide a brief description of the changes in this PR -->

## Related Issue
<!-- Link to the issue this PR addresses, e.g., Closes #123 -->

## Checklist
- [ ] Tests added or updated to cover these changes
- [ ] Documentation updated (README, inline comments, etc.)
- [ ] `task.json` inputs updated if new parameters were added
- [ ] No secrets, tokens, or real server URLs in fixtures or test files
- [ ] Linked issue above (if applicable)

## Testing
<!-- Commands run and their results. Agents: paste the output of the pr.yml checks from AGENTS.md. -->

| Command | Result |
|---|---|
| `npm run typecheck` | |
| `npm run typecheck:tab` | |
| `npm run lint` | |
| `npm run test:coverage` | |
| `npm run package` | |

## Risk
- [ ] Low
- [ ] Medium
- [ ] High

Why:

## How to revert or supersede
Marketplace versions are **immutable**: once a version is published it cannot
be replaced. Rollback means shipping a **new patch** (or, for a task-major
break, a new `tasks/*V2/` directory alongside the old one). A GitHub-only
change (docs, CI, review instructions) can be reverted with a revert PR.

## Authorship
- [ ] Written by a human
- [ ] Authored by an AI agent
  - Directed by: <!-- name / GitHub handle -->

## Additional Notes
<!-- Any additional information that reviewers should know -->
