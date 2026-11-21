import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { BackgroundService } from "./background-service.ts";

/** Chat line under a background command step: list, stop, open in the system browser. */
export function registerBackgroundRpc(
  handle: KernelRegisterRpc,
  background: BackgroundService,
  shutdown: AbortSignal,
) {
  handle("foregroundCommands.get", async ({ botId, runId, toolCallId }) =>
    background.foreground.get(botId, runId, toolCallId),
  );
  handle("foregroundCommands.promote", async ({ botId, runId, toolCallId }) =>
    background.foreground.promote(botId, runId, toolCallId),
  );
  handle("backgroundCommands.list", async ({ botId, limit, conversationId }) =>
    background.list(botId, limit, conversationId),
  );
  handle("backgroundCommands.page", async (query) => background.page(query));
  handle("backgroundCommands.stop", ({ botId, id }) => background.stop(botId, id, "user"));
  handle("backgroundCommands.continue", async ({ botId, id }) => {
    background.continuation.request(botId, id);
    return background.toolOutput(botId, id, 200).row;
  });
  handle("backgroundCommands.output", async ({ botId, id }) => ({
    text: background.toolOutput(botId, id, 20_000).output,
  }));
  handle("backgroundCommands.open", ({ botId, id, port }) =>
    background.open(botId, id, port, AbortSignal.any([shutdown, AbortSignal.timeout(15_000)])),
  );
}
