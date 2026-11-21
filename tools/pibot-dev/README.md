# pibot-dev

Maintainer tooling for developing Pi Bot with Pi Bot: a development Bot implements a planned task
over ACP in its own git worktree, and `pnpm pibot-dev` runs the steps that must happen outside any
agent sandbox (install, build, package, launch).

It reads the maintainers' planning documents (`docs/plans/`, `docs/specs/`, `docs/progress-notes/`
and `AGENTS.internal.md`), which live in a separate private repository and are not part of this
one. Without them the commands that start or resume a task fail when they read the plan; the rest of
the repository does not depend on this folder.
