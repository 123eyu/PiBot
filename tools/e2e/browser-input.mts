import assert from "node:assert/strict";
import type { Cdp } from "../dev/cdp/cdp.ts";
import type { Page } from "../dev/cdp/page.ts";

/** Trusted input reaches the real recorder; DOM .click() / assigned values can miss its listeners. */
export async function click(cdp: Cdp, page: Page, selector: string) {
  const point = await page.eval<{ x: number; y: number } | null>(`(() => {
    const el=document.querySelector(${JSON.stringify(selector)}); if(!el)return null;
    el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  assert(point, "e2e_fixture_control_missing");
  for (const type of ["mousePressed", "mouseReleased"])
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
}
export async function type(cdp: Cdp, page: Page, selector: string, text: string) {
  await click(cdp, page, selector);
  await cdp.send("Input.insertText", { text });
  await page.settle(500);
}
