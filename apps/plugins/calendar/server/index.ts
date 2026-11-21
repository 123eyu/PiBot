import { serveStdio } from "@pibot/plugin-sdk";
import { calendarAccessPromptMs, calendarScripts, calendarTools } from "./calendar.ts";

await serveStdio({
  id: "calendar",
  native: {
    app: "calendar",
    tools: calendarTools,
    scripts: calendarScripts,
    accessPromptMs: calendarAccessPromptMs,
  },
});
