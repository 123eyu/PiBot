import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { until } from "../chat/harness.ts";
import type { M3Fixture } from "./fixture.ts";

type Row = { label?: string; enabled?: boolean; click?(): void; submenu?: Row[] };
// Run today's tray module without loading Electron or constructing an OS window/tray.
export async function exerciseTray(f: M3Fixture) {
  const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const { build, stop } = createRequire(desktop.resolve("vite/package.json"))("esbuild");
  const capture: { rows: Row[]; listeners: number; destroyed: boolean } = {
    rows: [],
    listeners: 0,
    destroyed: false,
  };
  const key = "__pibotM3TrayFixture";
  const global = globalThis as typeof globalThis & Record<string, unknown>;
  global[key] = capture;
  let tray: { updateRoutines(value: unknown): void; destroy(): void } | undefined;
  try {
    const result = await build({
      entryPoints: [
        fileURLToPath(new URL("../../../apps/desktop/src/main/window/tray.ts", import.meta.url)),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      plugins: [
        {
          name: "fixture-electron",
          setup(plugin: {
            onResolve(
              options: { filter: RegExp },
              callback: () => { path: string; namespace: string },
            ): void;
            onLoad(
              options: { filter: RegExp; namespace: string },
              callback: () => { contents: string },
            ): void;
          }) {
            plugin.onResolve({ filter: /^electron$/ }, () => ({
              path: "electron",
              namespace: "fixture",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents:
                "const c=globalThis.__pibotM3TrayFixture;" +
                "export const Menu={buildFromTemplate:r=>(c.rows=r,{on(){}})};" +
                "export const nativeTheme={shouldUseDarkColors:false,on(){c.listeners++},off(){c.listeners--}};" +
                "export const nativeImage={createFromPath:()=>({setTemplateImage(){},toPNG(){return Buffer.alloc(0)}}),createEmpty:()=>({addRepresentation(){}})};" +
                "export class Tray{setToolTip(){}setContextMenu(){}setImage(){}on(){}destroy(){c.destroyed=true}}" +
                "export class Notification{static isSupported(){return false}show(){}}",
            }));
          },
        },
      ],
    });
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]?.text).toString("base64")}`
    );
    tray = module.createTray({
      resourcesDir: f.root,
      language: "zh",
      open() {},
      show() {},
      quitAll() {},
      routines: {
        pause: async (until: string) => {
          await f.rpc.call("routines.pauseAll", { until });
        },
        resume: async () => {
          await f.rpc.call("routines.resumeAll", undefined);
        },
        failed() {
          throw new Error("Tray action failed");
        },
      },
    });
    assert(tray);
    const current = tray;
    const push = async () => {
      const summary = await f.rpc.call("routines.summary", undefined);
      current.updateRoutines({
        next: summary.next,
        running: [],
        counts: summary.counts,
        pausedUntil: summary.pausedUntil,
      });
      await wait(300);
    };
    const summaryWhere = (label: string, ok: (pausedUntil: string | null) => boolean) =>
      until(
        label,
        () => f.rpc.call("routines.summary", undefined),
        (s) => ok(s.pausedUntil),
      );
    // Pause choices live in one submenu; while paused the block is a single resume row.
    const pauseChoices = () => {
      const choices = capture.rows.find((r) => r.submenu)?.submenu;
      assert.equal(choices?.length, 3);
      return choices;
    };
    const resume = async () => {
      const row = capture.rows.find((r) => r.click && r.label?.endsWith("· 恢复"));
      assert(row?.enabled);
      assert(!capture.rows.some((r) => r.submenu));
      row.click?.();
      await summaryWhere("真实托盘恢复RPC", (at) => at === null);
      await push();
    };
    await push();
    const before = Date.now();
    pauseChoices()[0]?.click?.();
    const hour = await summaryWhere("真实托盘暂停RPC", (at) => !!at);
    assert(Math.abs(Date.parse(hour.pausedUntil as string) - before - 3600000) < 2000);
    await push();
    await resume();
    pauseChoices()[1]?.click?.();
    const morning = new Date();
    morning.setHours(8, 0, 0, 0);
    if (morning.getTime() <= Date.now()) morning.setDate(morning.getDate() + 1);
    await summaryWhere("真实托盘明早RPC", (at) => at === morning.toISOString());
    await push();
    await resume();
    pauseChoices()[2]?.click?.();
    await summaryWhere("真实托盘直到恢复RPC", (at) => at === "9999-12-31T23:59:59.999Z");
    await push();
    await resume();
  } finally {
    tray?.destroy();
    stop();
    delete global[key];
  }
  assert.equal(capture.listeners, 0);
  assert(capture.destroyed);
}
