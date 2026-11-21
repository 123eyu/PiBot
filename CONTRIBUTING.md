# Contributing to Pi Bot

Thank you for helping. Issues and pull requests are welcome.

## Before you start

- Read [AGENTS.md](AGENTS.md): the hard constraints (Electron + TypeScript, pi only in
  `packages/agent`, a brain without Electron, three platforms, both languages and themes, security,
  no telemetry, command isolation) and the engineering practices apply to every change, whether a
  person or a coding agent writes it.
- For a bug, open an issue with the version, platform and steps to reproduce. Exported logs help;
  check that they contain nothing you do not want to share.
- For anything larger than a small fix (a new feature, a new dependency, a change to an interface
  in `packages/protocol` or to a layer boundary), open an issue first so we can agree on the
  approach before you spend time on it.
- Security problems: do not open a public issue; follow [SECURITY.md](SECURITY.md).

## Development

```sh
nvm use
pnpm install
pnpm dev                    # PIBOT_DATA_DIR=<folder> keeps a separate data folder
pnpm check:changed main     # quick checks while you work
pnpm verify                 # required before a pull request is merged
```

Tests never use the real network, real keys or your real user directory. New UI text goes
through `packages/i18n` in Chinese and English in the same change; colours come from the
`packages/ui` theme tokens.

## Pull requests

- Keep a pull request to one topic. Say what changed and why; for a bug, how to reproduce it and
  what caused it.
- Commit messages: `type(scope): subject` in English, then a body that explains the why (for
  example `fix(chat): forwarding many messages no longer fails on attachments`). A new
  third-party dependency is justified in the commit message.
- CI must pass. A maintainer reviews every change before it is merged.
- Never commit secrets, `.env` files or local paths.

## Developer Certificate of Origin

Every commit must be signed off, certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the
change or otherwise have the right to submit it under the project's license (Apache-2.0). Add the
line with `git commit -s`:

```
Signed-off-by: Your Name <you@example.com>
```

Use your real name or an established identity, and an email you can be reached at. Pull requests
with commits that are not signed off cannot be merged.

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
