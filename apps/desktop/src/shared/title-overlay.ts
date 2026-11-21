/**
 * Main → preload: this window draws the Windows/Linux controls as a titleBarOverlay. The renderer
 * cannot find out by itself in time: `navigator.windowControlsOverlay.visible` stays false until
 * Chromium lays out the shown window, and the first frame runs while it is still hidden.
 */
export const TITLE_OVERLAY_ARG = "--pibot-title-overlay";
