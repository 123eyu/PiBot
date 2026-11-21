export { type AcpAttachOptions, acpAttachError, attachAcp } from "./acp-attach.ts";
export { connectBackground } from "./background-connection.ts";
export { createBackgroundHeartbeat } from "./background-heartbeat.ts";
export { framedSocket, MAX_FRAME } from "./background-wire.ts";
export { type BackgroundDiscovery, readDescriptor } from "./descriptor.ts";
