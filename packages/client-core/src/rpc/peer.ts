import type { Events, Methods, Peer } from "@pibot/protocol";

export type ClientPeer = Peer<typeof Methods, typeof Events>;
