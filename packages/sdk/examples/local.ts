import { createHeadless } from "../../../apps/cli/src/headless.ts";
import { createPiBotClientFromPeer } from "../src/index.ts";

const [dataDir, text] = process.argv.slice(2);
if (!dataDir || !text) throw new Error("Usage: local.ts <data-dir> <message>");

const headless = createHeadless(dataDir);
await headless.ready;
const client = createPiBotClientFromPeer(headless.client);

try {
  const bot = (await client.listBots({ limit: 1 }))[0];
  if (!bot) throw new Error("No Bot configured");
  const sent = await client.sendMessage({ botId: bot.id, text });
  for await (const event of client.streamRunEvents({ runId: sent.runId })) {
    console.log(JSON.stringify(event));
  }
} finally {
  client.dispose();
  await headless.stop();
}
