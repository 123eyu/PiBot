import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TranslationKey, t } from "../../../packages/i18n/src/index.ts";
import type { Cdp } from "./cdp.ts";

export interface WindowBounds {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  windowState?: "normal" | "minimized" | "maximized" | "fullscreen";
}

/** Runs inside the page. Finds visible elements by text/ARIA label, never by CSS-module classes. */
const helper = String.raw`(() => {
  // Redefined on every call: an app that stays open keeps an older driver's helper otherwise.
  const visible = (el) => !!(el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
  const label = (el) => [el.getAttribute("aria-label"), el.getAttribute("title"), (el.innerText || "").trim()]
    .filter(Boolean).map((s) => s.replace(/\s+/g, " ").trim());
  const clickable = "button,a,[role=button],[role=tab],[role=menuitem],[role=option],label,summary,select,input,textarea,[tabindex]";
  window.__piDriver = {
    find(texts, { exact = true, scope = "clickable" } = {}) {
      const nodes = [...document.querySelectorAll(scope === "clickable" ? clickable : "*")].filter(visible);
      const match = (s) => texts.some((t) => (exact ? s === t : s.includes(t)));
      // Innermost match wins, so a card containing the button text is not picked over the button.
      const hits = nodes.filter((el) => label(el).some(match));
      return hits.find((el) => !hits.some((other) => other !== el && el.contains(other))) ?? hits[0] ?? null;
    },
    click(texts, options) {
      const el = this.find(texts, options);
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    },
    hasText(texts) {
      const body = document.body.innerText.replace(/\s+/g, " ");
      // Placeholders and ARIA labels name controls that have no visible text (search boxes).
      const named = [...document.querySelectorAll("[placeholder],[aria-label]")].filter(visible)
        .flatMap((el) => [el.getAttribute("placeholder"), el.getAttribute("aria-label")]).filter(Boolean);
      return texts.some((t) => body.includes(t) || named.includes(t));
    },
    setValue(texts, value) {
      // Labels name their control; React needs the native setter plus an input/change event.
      const labelEl = [...document.querySelectorAll("label")].filter(visible).find((l) => label(l).some((s) => texts.some((t) => s.startsWith(t))));
      const control = labelEl?.control ?? labelEl?.querySelector("input,textarea,select") ?? this.find(texts);
      if (!control) return false;
      const proto = control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(control, value);
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    selectIndex(texts, index) {
      const labelEl = [...document.querySelectorAll("label")].filter(visible).find((l) => label(l).some((s) => texts.some((t) => s.startsWith(t))));
      const select = labelEl?.control ?? labelEl?.querySelector("select");
      if (!(select instanceof HTMLSelectElement) || !select.options[index]) return false;
      return this.setValue(texts, select.options[index].value) && select.options[index].text;
    },
  };
})()`;

export interface PageOptions {
  signal?: AbortSignal;
  capture?: (
    page: Page,
    name: string,
    capture: (name: string) => Promise<string>,
  ) => Promise<string>;
}

export class Page {
  readonly errors: string[] = [];
  private step = 0;
  private readonly cdp: Cdp;
  private readonly outDir: string;
  private readonly off: () => void;
  private readonly options: PageOptions;
  constructor(cdp: Cdp, outDir: string, options: PageOptions = {}) {
    this.options = options;
    this.cdp = cdp;
    this.outDir = outDir;
    this.off = cdp.on((event) => {
      if (this.errors.length >= 1000) return;
      if (event.method === "Runtime.exceptionThrown") {
        const details = event.params.exceptionDetails as {
          exception?: { description?: string };
          text?: string;
        };
        this.errors.push(
          details.exception?.description?.split("\n")[0] ?? details.text ?? "exception",
        );
      } else if (event.method === "Runtime.consoleAPICalled" && event.params.type === "error") {
        const args = event.params.args as { value?: unknown; description?: string }[];
        this.errors.push(
          args
            .map((a) => String(a.value ?? a.description ?? ""))
            .join(" ")
            .slice(0, 400),
        );
      }
    });
  }

  /**
   * `waitForApp: false` is for pages that are not the mounted main window: a fresh profile's
   * welcome screen (tools/e2e initializes through it) or a Bot browser tab.
   */
  async start({ waitForApp = true }: { waitForApp?: boolean } = {}) {
    await this.cdp.send("Runtime.enable");
    await this.cdp.send("Page.enable");
    await mkdir(this.outDir, { recursive: true });
    await this.eval(helper);
    if (waitForApp) await this.waitForApp();
  }

  /**
   * The startup sidebar paints 「待办」 and an unwired 「连接」 before the app mounts, so a flow that
   * waits for text alone clicks the placeholder and nothing happens. Only the mounted sidebar's
   * button carries `data-connectors-trigger`.
   */
  async waitForApp(timeoutMs = 90_000) {
    const until = Date.now() + timeoutMs;
    while (!(await this.eval<boolean>('!!document.querySelector("[data-connectors-trigger]")'))) {
      if (Date.now() > until) throw new Error("the app never finished mounting");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Both languages: tests pass whichever language the app currently shows. */
  texts(key: TranslationKey | string, vars?: Record<string, string | number>): string[] {
    if (!key.includes(".") || key.includes(" ")) return [key];
    const k = key as TranslationKey;
    return [...new Set([t(k, vars, "zh"), t(k, vars, "en")])];
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    this.options.signal?.throwIfAborted();
    const result = await this.cdp.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails)
      throw new Error(`page eval failed: ${result.exceptionDetails.text}`);
    return result.result.value as T;
  }

  private call(method: string, ...args: unknown[]) {
    return this.eval(`(${helper}, window.__piDriver.${method}(...${JSON.stringify(args)}))`);
  }

  async click(key: string, options: { exact?: boolean } = {}) {
    if (!(await this.call("click", this.texts(key), options))) throw new Error(`not found: ${key}`);
    await this.settle();
  }

  async has(key: string) {
    return (await this.call("hasText", this.texts(key))) as boolean;
  }

  async waitFor(key: string, timeoutMs = 8000) {
    const until = Date.now() + timeoutMs;
    while (!(await this.has(key))) {
      if (Date.now() > until) throw new Error(`timed out waiting for: ${key}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async fill(labelKey: string, value: string) {
    if (!(await this.call("setValue", this.texts(labelKey), value)))
      throw new Error(`no field: ${labelKey}`);
    await this.settle();
  }

  async selectIndex(labelKey: string, index: number) {
    const picked = await this.call("selectIndex", this.texts(labelKey), index);
    if (!picked) throw new Error(`no select: ${labelKey}`);
    await this.settle();
    return picked as string;
  }

  async key(key: "Escape" | "Enter" | "Tab") {
    const codes = { Escape: 27, Enter: 13, Tab: 9 };
    for (const type of ["keyDown", "keyUp"] as const)
      await this.cdp.send("Input.dispatchKeyEvent", {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: codes[key],
      });
    await this.settle();
  }

  /** Electron exposes no Browser domain; callers then fall back to viewport emulation. */
  async windowBounds() {
    try {
      return await this.cdp.send<{ windowId: number; bounds: WindowBounds }>(
        "Browser.getWindowForTarget",
      );
    } catch {
      return undefined;
    }
  }

  async setWindowBounds(windowId: number | undefined, bounds: WindowBounds) {
    if (windowId === undefined) return;
    await this.cdp.send("Browser.setWindowBounds", { windowId, bounds });
    await this.settle();
  }

  async viewportWidth(width?: number) {
    if (width === undefined) await this.cdp.send("Emulation.clearDeviceMetricsOverride");
    else
      await this.cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 800,
        deviceScaleFactor: 0,
        mobile: false,
      });
    await this.settle();
  }

  async shot(name: string) {
    if (this.options.capture)
      return this.options.capture(this, name, (value) => this.capture(value));
    return this.capture(name);
  }

  private async capture(name: string) {
    const { data } = await this.cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    const safe = name.replace(/[^\p{L}\p{N}_.-]/gu, "-").slice(0, 160);
    const file = join(this.outDir, `${String(++this.step).padStart(2, "0")}-${safe}.png`);
    await writeFile(file, Buffer.from(data, "base64"));
    return file;
  }

  /** React commits and lazy chunks land within a few frames; RPC-backed views need a bit longer. */
  async settle(ms = 400) {
    this.options.signal?.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  dispose() {
    this.off();
  }
}
