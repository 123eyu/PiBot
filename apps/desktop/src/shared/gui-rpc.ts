import { z } from "zod";

export const GUI_RPC_CAPACITY = 16;
export const GUI_RPC_QUEUE_LIMIT = 64;
/** Stop retains a slot even while approval/cancellation handlers are draining. */
export function guiRpcReservation(method: string) {
  if (method === "chat.abort") return 0;
  if (
    [
      "approvals.resolve",
      "groups.files.cancel",
      "providers.cancelLogin",
      "teams.cancel",
      "memory.cancelSortIntoPlace",
    ].includes(method)
  )
    return 1;
  return 2;
}

const id = z.union([z.string().max(100), z.number().int().safe(), z.null()]);
export const GuiRpcRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id,
  method: z.string().max(100),
  params: z.unknown().optional(),
});
// These envelopes stop at GUI main; neither the owner nor embedded Windows brain receives them.
export const GuiRpcDispatchSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("request"),
    message: GuiRpcRequestSchema,
    deadline: z.number().int().nonnegative().safe(),
  }),
  z.strictObject({ kind: z.literal("cancel"), id }),
  z.strictObject({ kind: z.literal("dispose") }),
]);
export type GuiRpcRequest = z.infer<typeof GuiRpcRequestSchema>;
