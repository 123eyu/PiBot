// The GUI must evaluate these before it can spawn the owner. Importing them through the
// package root evaluated every protocol schema first (two chunks, ~640 KB) on that critical path;
// this subpath keeps the launch/descriptor/wire closure to its own few small modules.
export { FILE_LIMIT, MAX_ATTACHMENTS } from "../chat/attachments.ts";
export { RpcError, RpcErrorCodes } from "../core/peer.ts";
export * from "../execution/independent-background.ts";
