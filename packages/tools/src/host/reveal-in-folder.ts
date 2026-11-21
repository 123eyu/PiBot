import { type AuditDetail, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import type { PreparedToolView, ToolResult, ToolRuntime } from "../runtime/tool-runtime.ts";

export async function revealInFolder(
  runtime: ToolRuntime,
  prepared: PreparedToolView,
  auditFields: AuditDetail,
  signal: AbortSignal,
): Promise<ToolResult> {
  const show = runtime.revealPath;
  if (!show)
    return {
      text: "这里没有桌面窗口，不能在文件管理器里显示；请把路径告诉用户 / No desktop is available here to show it in a file manager; tell the user the path instead",
      isError: true,
    };
  const path = prepared.result.path?.path;
  const root = prepared.result.path?.root;
  if (!path || !root)
    return {
      text: "只能显示本轮可读文件夹里的文件或文件夹 / Not inside this run's readable folders",
      isError: true,
    };
  runtime.assertDispatch(prepared);
  const active = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  try {
    await abortable(show({ path, allowedRoots: [root] }, active), active);
  } catch (error) {
    if (signal.aborted) throw error;
    const code = error instanceof RpcError ? error.code : undefined;
    if (code === undefined || code === RpcErrorCodes.internal)
      runtime.log("warn", {
        module: "reveal",
        event: "reveal_failed",
        botId: runtime.context.botId,
        runId: runtime.context.runId,
        code: code ?? "error",
      });
    return {
      text:
        code === RpcErrorCodes.unsupported
          ? "桌面窗口当前不可用，不能在文件管理器里显示；请把路径告诉用户 / The desktop is not available right now; tell the user the path instead"
          : code === RpcErrorCodes.invalidParams
            ? "路径已变化或不在可读文件夹里，未显示 / The path changed or is outside the readable folders; nothing was shown"
            : "文件管理器没有打开，请把路径告诉用户，不要改用操作电脑 / The file manager did not open; tell the user the path instead of using computer use",
      isError: true,
    };
  }
  runtime.auditRevealed({ ...auditFields, toolCallId: prepared.call.id, path });
  return { text: runtime.redact(`已在文件管理器中显示 / Shown in the file manager: ${path}`) };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}
