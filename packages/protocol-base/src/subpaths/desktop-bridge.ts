// What the desktop preload validates. The preload runs before any page script of every
// window; through the package root it evaluated every protocol schema first (~0.75 MB bundle).
export * from "../app/desktop-updates.ts";
export { BROWSER_FRAME_CHANNEL } from "../browser/browser.ts";
export { CanonicalTimeSchema } from "../core/boundaries.ts";
export { IdSchema } from "../core/ids.ts";
export * from "./background.ts";
