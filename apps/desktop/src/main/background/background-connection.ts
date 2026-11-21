import { connectBackground as connect } from "@pibot/sdk/node";
import type { WindowsBackgroundSecurity } from "./windows-background-security.ts";

type Args = Parameters<typeof connect>;
export function connectBackground(
  dataDir: Args[0],
  version: Args[1],
  receive: Args[2],
  closed: Args[3],
  signal?: Args[4],
  windows?: WindowsBackgroundSecurity,
) {
  return connect(dataDir, version, receive, closed, signal, undefined, windows?.discovery);
}
