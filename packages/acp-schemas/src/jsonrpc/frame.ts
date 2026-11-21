import { z } from "zod";

/*
 * One newline-delimited JSON-RPC 2.0 frame from the other ACP side. Only the envelope is checked
 * here; `params` and `result` stay unknown until the method's own schema validates them.
 */
const rpcId = z.union([z.number().int().safe(), z.string().min(1).max(200)]);
export const rpcError = z.looseObject({
  code: z.number().int(),
  message: z.string().max(4000),
  data: z.unknown().optional(),
});
const method = z.string().min(1).max(200);
export const rpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: rpcId,
  method,
  params: z.unknown().optional(),
});
export const rpcNotification = z.object({
  jsonrpc: z.literal("2.0"),
  method,
  params: z.unknown().optional(),
});
export const rpcResult = z.object({ jsonrpc: z.literal("2.0"), id: rpcId, result: z.unknown() });
export const rpcErrorResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: rpcId.nullable(),
  error: rpcError,
});
/** Tagged by shape, in this order: a request carries both `id` and `method`. */
export type RpcFrame =
  | ({ type: "request" } & z.infer<typeof rpcRequest>)
  | ({ type: "notification" } & z.infer<typeof rpcNotification>)
  | ({ type: "result" } & z.infer<typeof rpcResult>)
  | ({ type: "error" } & z.infer<typeof rpcErrorResponse>);

export function parseRpcFrame(value: unknown): RpcFrame | undefined {
  if (!value || typeof value !== "object") return undefined;
  const has = (key: string) => Object.hasOwn(value, key);
  if (has("method")) {
    if (has("id")) {
      const parsed = rpcRequest.safeParse(value);
      return parsed.success ? { type: "request", ...parsed.data } : undefined;
    }
    const parsed = rpcNotification.safeParse(value);
    return parsed.success ? { type: "notification", ...parsed.data } : undefined;
  }
  if (has("error")) {
    const parsed = rpcErrorResponse.safeParse(value);
    return parsed.success ? { type: "error", ...parsed.data } : undefined;
  }
  const parsed = rpcResult.safeParse(value);
  return parsed.success && has("result") ? { type: "result", ...parsed.data } : undefined;
}
export type RpcId = z.infer<typeof rpcId>;
