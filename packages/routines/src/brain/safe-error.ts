import { unavailableErrnos, unavailableExecCodes } from "@pibot/brain/kit";
import { RpcError } from "@pibot/protocol";

// Built-in argument/shape errors say which layer misread its input without quoting a value.
const builtinErrors = new Set(["TypeError", "RangeError", "SyntaxError"]);

/**
 * Error messages can contain paths or secrets from an injected adapter, so logs keep only a fixed
 * name and a trusted code. The code is still enough to tell which layer failed. The errno
 * and ExecError code sets are the workplace ones, so a folder problem is classified the same way
 * here as it is in the routine list's run mapping.
 */
export function safeErrorDetails(error: unknown): { errorName: string; code: string | number } {
  if (error instanceof RpcError) return { errorName: "RpcError", code: error.code };
  if (error instanceof Error && builtinErrors.has(error.name))
    return { errorName: error.name, code: "unknown" };
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && unavailableErrnos.has(code))
    return { errorName: "NodeError", code };
  if (typeof code === "string" && unavailableExecCodes.has(code))
    return { errorName: "ExecError", code };
  return { errorName: "UnknownError", code: "unknown" };
}
