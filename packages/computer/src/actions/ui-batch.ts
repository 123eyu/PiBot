import type { HostComputerParams, HostComputerResults } from "@pibot/protocol-base";
import { type Call, resolveApp, resolveWindow, type ServiceContext } from "../core/context.ts";
import { defaultDisposition, failure } from "../core/errors.ts";
import { uiAction } from "./input.ts";

/** One queue lease, never a new grant or an automatic retry of a partially executed sequence. */
export async function uiBatch(
  ctx: ServiceContext,
  call: Call,
  p: Extract<HostComputerParams["host.computer.uiAction"], { action: "batch" }>,
  unexpected: (error: unknown) => void,
): Promise<HostComputerResults["host.computer.uiAction"]> {
  let completed = 0;
  let effect: "confirmed" | "unverified" = "confirmed";
  const originalSignal = call.signal;
  call = { ...call, signal: AbortSignal.any([call.signal, AbortSignal.timeout(30_000)]) };
  try {
    const app = await resolveApp(ctx, call, p.app);
    const found = await resolveWindow(ctx, call, app, p.window);
    const window = { ...found, bounds: { ...found.bounds } };
    for (const action of p.actions) {
      ctx.grants.verify(p.token);
      call.signal.throwIfAborted();
      const result = await uiAction(
        ctx,
        call,
        { ...action, token: p.token, app: p.app, window: window.id },
        window,
      );
      completed++;
      if (result.effect === "unverified") effect = "unverified";
    }
    return { ok: true, effect, completed };
  } catch (error) {
    const code = originalSignal.aborted ? ("cancelled" as const) : ("timeout" as const);
    const expected =
      failure(error) ??
      (call.signal.aborted
        ? { ok: false as const, code, disposition: defaultDisposition(code) }
        : undefined);
    if (!expected) unexpected(error);
    return {
      ...(expected ?? {
        ok: false as const,
        code: "driver_error" as const,
        disposition: defaultDisposition("driver_error"),
      }),
      completed,
    };
  }
}
