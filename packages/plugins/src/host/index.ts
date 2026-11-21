/**
 * Connectors, host entry: the desktop main process half. Plugin imports go through a
 * short-lived selection the user picked in a system dialog; the renderer never sees a path. No
 * Electron import here: the desktop passes its `dialog`.
 */
export { createConnectorImportHost, type ImportDialogs } from "./import-host.ts";
export { detectKnowledge } from "./knowledge-detect.ts";
export { type OpenKnowledgeNoteParams, openKnowledgeNote } from "./knowledge-open.ts";
