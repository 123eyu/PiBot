import { RpcError } from "@pibot/protocol-base";

export function businessResult<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    // Match repository business refusals exactly; unrelated SQLite/program errors stay internal.
    if (
      error instanceof Error &&
      ["Unknown active sidebar target", "Cannot hide main Bot", "Unknown topic"].includes(
        error.message,
      )
    )
      throw new RpcError(-32602, error.message);
    throw error;
  }
}
