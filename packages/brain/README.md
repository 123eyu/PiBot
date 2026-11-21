# @pibot/brain

Pure Node business orchestration; no Electron, pi imports, tools or subprocess execution.

```ts
import { startBrain } from "@pibot/brain";
import { createOrchestrationFactory } from "@pibot/orchestration";

const brain = await startBrain({
  port,
  host,
  dataDir,
  version,
  platform,
  orchestration: createOrchestrationFactory(),
});
// Before quitting or replacing the utilityProcess:
await brain.stop();
```

`port` implements protocol's `Port`. `host.secrets` implements `SecretCipher` through
main's host RPC; `host.env.detect()` returns names only, while `host.env.read(name)`
is used only by explicit `providers.importFromEnv`. Main must retain its own original
environment: run brain in the dedicated utilityProcess, never initialize it in main.
`startBrain` intentionally sanitizes the brain process environment using `dataDir`.

Initialization runs migrations, ensures Pi, creates a redactor and SecretStore,
hydrates custom providers, creates AgentRuntime, and registers 17 handlers.
Protocol itself owns the eighteenth method, `events.resume`, including sequence
assignment and replay. `brain.status` remains main's responsibility.

Provider row identity is **(id, auth)**. Anthropic API Key and Claude subscription
rows share an id; only apiKey/custom rows were available at first. Builtin keys are
stored under `provider:<id>` / `apiKey`. Custom header maps are encrypted as JSON
under the same scope / `headers`; even seemingly nonsecret header values stay out
of provider config. Startup hydrates only public configs. Headers are decrypted and
registered with the redactor when chatting, testing, or fetching saved models.
`customProviders.get` reports `hasHeaders` without decryption; header names can remain
unknown until the first credential use. Provider/model lists and Bot updates never
probe the keyring. Key presence and saved hints come only from SQLite.
Omitted API Key/headers preserve existing credentials; `headers: {}` clears headers.
`providers.remove` deletes the scope and custom config (builtin catalog entries remain).
Encrypted writes complete before an atomic transaction replaces custom configuration.
URLs with embedded credentials are rejected; use the Key/header inputs instead.

Custom configs go through `customProviders.upsert`. An explicit `id: "ollama"`
uses the fixed local endpoint and `supportsDeveloperRole: false`; detection never
registers anything. Detection uses a 1500 ms deadline, rejects redirects, and returns
`running: false` on failed, malformed or timed-out responses.

Chat locks a Bot before asynchronous model availability checks. `no_model` emits
`chat.error` and rejects the RPC with -32010 before any rows are written. Because
protocol requires UUIDs on this event, its transient run/message ids do not reference
persisted rows. A busy Bot rejects with -32011; it does not fail the active run.
Accepted sends immediately return ids; events carry the asynchronous result.
Each DM retains one JSONL path, reopened per run so changed models, thinking levels
and language settings apply. Pi personas use the explicit language or Node's system
locale; both ask Pi to follow the user's language.

SQLite checkpoints accumulated output every 500 ms, then flushes on success/error/abort.
The schema has no stop_reason column, so successful usage JSON retains the usage fields
plus `stopReason`; errors and aborts persist their corresponding stop reason there.
`chat.done.usage` retains the agent usage shape. Startup marks interrupted streaming
rows aborted. `stop()` is idempotent, prevents new calls, stops runs, waits for accepted
RPCs and credential writes, disposes the peer, then closes SQLite.

Logs contain operation/run ids and mapped codes, never prompts, raw SDK diagnostics
or credentials. Credentials are registered with the redactor on writes and before
decrypted plaintext reaches request code. Undecrypted values are absent from memory.
Outbound messages and history are redacted; known credential prefixes are held across
stream delta boundaries. Known credentials in user prompts are also redacted before
passing them to the pi session, avoiding their persistence in user-message JSONL.

`piVersion` comes from the bundled SDK's `VERSION`, exposed by `@pibot/agent`;
there is no second version constant to maintain. Packaged migration resource placement belongs to packaging; this
entry point uses store's default migration directory, which must accompany its code.

Tests use temporary SQLite, memory ports, fake host cipher, mock AgentRuntime and
fake fetch exclusively. The cipher in tests is deliberately unsuitable for production.
