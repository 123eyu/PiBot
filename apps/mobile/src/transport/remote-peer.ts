import {
  createPeer,
  IdSchema,
  Methods,
  type Port,
  RemoteEvents,
  RemoteMethods,
} from "@pibot/protocol";
import { createLenient, lenientMethods } from "./lenient.ts";

// Phone-session metadata comes from the remote capability's contract; chat.send carries the
// client message ID the desktop gateway uses for idempotent delivery (remote/brain/rpc/gateway.ts).
export const MobileRemoteMethods = {
  "devices.self": RemoteMethods["devices.self"],
  "remote.session.update": RemoteMethods["remote.session.update"],
  // Share upload slices and the phone's data switches.
  "remote.share.upload": RemoteMethods["remote.share.upload"],
  "remote.phoneData.state": RemoteMethods["remote.phoneData.state"],
  "chat.send": {
    ...Methods["chat.send"],
    params: Methods["chat.send"].params.safeExtend({ clientMessageId: IdSchema }),
  },
};
// Answers from a newer desktop may carry fields this phone does not know yet.
const ReadMethods = lenientMethods(MobileRemoteMethods, createLenient());
export function remotePeer(port: Port) {
  // Metadata/outbox and application Peers share a wire, with disjoint request UUIDs.
  // Only the connection owner may dispose the underlying encrypted Port.
  return createPeer(
    {
      post: (value) => port.post(value),
      onMessage: (fn) => port.onMessage(fn),
      cancelRequest: (id) => port.cancelRequest?.(id),
      onRequestCancel: (fn) => port.onRequestCancel?.(fn) ?? (() => {}),
    },
    { methods: ReadMethods, events: { "remote.interactive": RemoteEvents["remote.interactive"] } },
  );
}
