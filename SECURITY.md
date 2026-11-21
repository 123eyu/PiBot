# Security policy

## Reporting a vulnerability

Please do not report security problems in public issues, discussions or pull requests.

Report them privately through GitHub: on this repository's **Security** tab choose
**Report a vulnerability** (private vulnerability reporting). Include:

- the Pi Bot version and platform (macOS, Windows, Linux, Android, runner or relay);
- what an attacker can do, and what they need first (a malicious web page, file, MCP server,
  model reply, a paired device, local access, …);
- steps to reproduce, or a proof of concept.

Leave out real secrets, chats or personal files; describe them instead. We acknowledge a report
within a few days, keep you informed while we fix it, and credit you in the advisory unless you
prefer not to be named.

## Scope

Of particular interest:

- a tool call that bypasses `packages/policy` or an approval;
- a command that escapes the sandbox (`packages/execution`), or writes outside the folders it was
  allowed;
- secrets reaching logs, the renderer, a model prompt or a third party;
- the phone, runner or relay links: pairing, end-to-end encryption, revocation;
- prompt injection that turns untrusted content (pages, files, tool output, group messages) into
  actions the user did not approve.

Problems that need an already compromised computer or account, or a model provider's own
behaviour, are usually out of scope, but tell us if you are unsure.

## Supported versions

Fixes go into the latest release. Pi Bot updates itself; please check that you are on the latest
version before reporting.
