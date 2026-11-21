import { RpcError } from "@pibot/protocol-base";

/**
 * The workplace registry keeps the person's folders and an ACP session's folders in two
 * separate pools, and both full pools mean the same thing to a caller — remove one before adding
 * another. Refusals stay business errors (`-32602`, message intact) rather than bare TypeErrors,
 * which every RPC wrapper reports as `internal`; an ACP client could then not tell "capacity" from
 * "bug" and would not know to ask the person to remove a folder.
 *
 * Lives beside the service so the boundary can be replayed without a database or an app.
 */
const CAPACITY_REFUSALS = new Set(["Too many working folders", "Too many session working folders"]);

export function refuseFolderCapacity(error: unknown): never {
  if (error instanceof TypeError && CAPACITY_REFUSALS.has(error.message))
    throw new RpcError(-32602, error.message);
  throw error;
}
