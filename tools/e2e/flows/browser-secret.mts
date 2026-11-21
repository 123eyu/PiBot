import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.mts";
import { freePort, until } from "../util.mts";

const HANDLE = /«secret:h[a-f0-9]{32}»/;
const PLACEHOLDER = "E2E_HANDLE_PLACEHOLDER";

/** Every file under `dir` (bounded), for scanning persisted state for a raw value. */
async function files(dir: string, out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 8 || out.length > 5000) return out;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await files(path, out, depth + 1);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/**
 * Secret handles in the real app. Handles live as long as the page that produced them (the
 * Bot browser sleeps after a run), so capture and both uses happen in one run: the fake model
 * receives the handle in the network result and its next scripted calls are filled in before it
 * answers. The site must receive the real token after a fresh approval, and neither the model,
 * the database, session files nor the command output may ever hold the raw token.
 */
export async function run(c: Context) {
  const port = await freePort(),
    token = crypto.randomUUID();
  let site = "";
  let accessToken = "";
  const receipt = async () =>
    (await fetch(`${site}/__receipt`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    }).then((r) => r.json())) as {
      accessToken: string;
      receipts: { authorization: string | null }[];
    };
  await c.step("secret-site-fixture", async () => {
    site = await c.fixture("secret", port, token);
    accessToken = (await receipt()).accessToken;
    assert.match(accessToken, /^e2e-secret-[a-f0-9]{24}$/);
  });
  let handle = "";
  c.onRequest = (text) => {
    if (handle || !text.includes("/api/session")) return;
    const found = text.match(HANDLE)?.[0];
    if (!found) return;
    handle = found;
    // Later scripted calls carry the placeholder; fill it before the model's next answer.
    for (const reply of c.scenario.replies)
      for (const call of reply.toolCalls ?? [])
        call.arguments = JSON.parse(JSON.stringify(call.arguments).replaceAll(PLACEHOLDER, found));
  };
  c.scenario.replies.splice(
    c.modelRequests,
    c.scenario.replies.length,
    { toolCalls: [{ name: "browser_open", arguments: { url: `${site}/` } }] },
    { toolCalls: [{ name: "tool_discover", arguments: { groups: ["browser"] } }] },
    { toolCalls: [{ name: "browser_network", arguments: {} }] },
    {
      toolCalls: [
        {
          name: "browser_request",
          arguments: {
            origin: site,
            url: "/api/echo",
            method: "GET",
            headers: { Authorization: `Bearer ${PLACEHOLDER}` },
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          name: "run_command",
          arguments: {
            command: 'printf "token=%s\\n" "$E2E_TOKEN"',
            env: { E2E_TOKEN: PLACEHOLDER },
          },
        },
      ],
    },
    { text: "E2E secret flow done" },
  );
  let turn: Awaited<ReturnType<Context["receipt"]>> | undefined;
  await c.step("capture-handle", async () => {
    turn = await c.receipt("Use the page's session token for the echo API.");
    await until("handle_captured", async () => handle, Boolean, c.signal);
    assert(
      c.requestTexts.every((text) => !text.includes(accessToken)),
      "raw_token_in_model_request",
    );
  });
  await c.step("request-asks-then-sends", async () => {
    await c.page.waitFor("approval.allowOnce", 30_000);
    await c.page.shot("secret-request-approval");
    // A secret use is never rememberable.
    assert.equal(await c.page.has("approval.allowAlways"), false, "secret_approval_rememberable");
    await c.page.click("approval.allowOnce");
    const rows = await until(
      "echo_receipt",
      async () => (await receipt()).receipts,
      (r) => r.length >= 1,
      c.signal,
    );
    assert.equal(rows.at(-1)?.authorization, `Bearer ${accessToken}`, "site_did_not_get_value");
  });
  await c.step("command-env-asks-and-output-masked", async () => {
    await c.page.waitFor("approval.allowOnce", 30_000);
    await c.page.shot("secret-env-approval");
    assert.equal(await c.page.has("approval.allowAlways"), false, "secret_env_rememberable");
    await c.page.click("approval.allowOnce");
    assert(turn, "turn_missing");
    await c.done(turn);
    const result = c.requestTexts.find((text) => text.includes("token="));
    assert(result?.includes(`token=${handle}`), "command_output_not_masked_to_handle");
  });
  await c.step("no-raw-token-anywhere", async () => {
    assert(
      c.requestTexts.every((text) => !text.includes(accessToken)),
      "raw_token_in_model_request",
    );
    const leaked: string[] = [];
    for (const path of await files(c.data)) {
      // The Bot browser's own profile legitimately caches the site's responses.
      if (/[\\/](Partitions|browser)[\\/]/.test(path.slice(c.data.length))) continue;
      const bytes = await readFile(path).catch(() => undefined);
      if (bytes?.includes(accessToken)) leaked.push(path.slice(c.data.length));
    }
    assert.deepEqual(leaked, [], `raw_token_persisted:${leaked.slice(0, 5).join(",")}`);
  });
}
