import { serveStdio } from "@pibot/plugin-sdk";
import { contactAccessPromptMs, contactScripts, contactTools } from "./contacts.ts";

await serveStdio({
  id: "contacts",
  native: {
    app: "contacts",
    tools: contactTools,
    scripts: contactScripts,
    accessPromptMs: contactAccessPromptMs,
  },
});
