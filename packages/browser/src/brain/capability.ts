import type { BrainCapability } from "@pibot/brain/kit";
import { BROWSER_REMOTE_PORT, RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import { AuditRepo } from "@pibot/storage";
import { registerBrowserDebugRpc } from "./service/browser-debug-rpc.ts";
import { createBrowserRemotePort } from "./service/browser-remote-port.ts";
import { BrowserViewService, registerBrowserRpc } from "./service/browser-rpc.ts";
import { BrowserService } from "./service/browser-session.ts";
import { registerExtensionRpc } from "./service/extension-rpc.ts";
export function browserCapability(): BrainCapability {
  return {
    id: "browser",
    register(ctx) {
      let closed = false;
      const pending = new Set<Promise<unknown>>();
      const track = <T>(work: Promise<T>) => {
        pending.add(work);
        // The caller owns rejection; these branches only remove the drain entry.
        void work.then(
          () => pending.delete(work),
          () => pending.delete(work),
        );
        return work;
      };
      const handle: typeof ctx.rpc.handle = (method, action) =>
        ctx.rpc.handle(method, (params, context) => {
          if (closed) throw new RpcError(RpcErrorCodes.closed, "browser_stopped");
          return track(Promise.resolve().then(() => action(params, context)));
        });
      const session = new BrowserService(ctx.browser.environment);
      const view = new BrowserViewService({
        host: ctx.host.browserView,
        peer: ctx.peer,
        logger: ctx.logger,
        audit: new AuditRepo(ctx.db, ctx.redactor),
        session,
        notices: ctx.browser.notices,
        beginTakeover: ctx.browser.beginTakeover,
        groups: { members: ctx.browser.members, session: (id) => session.forGroup(id) },
      });
      session.onChange = (id, groupId) => view.changed(id, groupId);
      session.onHandBack = (id) => {
        const work = ctx.browser
          .afterHandBack(id)
          .catch(() => ctx.logger.warn("Browser hand-back credential capture failed"));
        track(work);
      };
      ctx.browser.provide(session, view);
      registerBrowserRpc(handle, view);
      // The phone remote reaches the same view service the desktop overlay uses.
      ctx.ports.provide(
        BROWSER_REMOTE_PORT,
        createBrowserRemotePort(view, (action) => {
          if (closed) return Promise.reject(new RpcError(RpcErrorCodes.closed, "browser_stopped"));
          return track(Promise.resolve().then(action));
        }),
      );
      registerBrowserDebugRpc(handle, ctx);
      const registerExtension = registerExtensionRpc(handle, ctx);
      ctx.sleep.participate({ idle: () => session.isIdle() });
      return {
        // Not on the startup path: the manifests are written after the app is ready.
        afterReady: (signal: AbortSignal) => registerExtension(signal),
        stop: async () => {
          closed = true;
          // An admitted hand-back RPC can start credential capture while it settles.
          while (pending.size) await Promise.allSettled([...pending]);
        },
      };
    },
  };
}
