export interface ListeningSocket {
  pid: number;
  /** Local address as the OS reports it; "0.0.0.0" / "::" mean every interface. */
  address: string;
  port: number;
}

export type ListenerScan =
  | {
      supported: true;
      sockets: ListeningSocket[];
      /** Linux: pids running in another network namespace (a bubblewrap-isolated command). */
      namespaced?: readonly number[];
    }
  | {
      supported: false;
      /**
       * network_namespace: Linux runs each sandboxed command in its own network namespace
       * (bubblewrap --unshare-net), so its ports are unreachable from this machine. A command
       * the user allowed to run without isolation shares ours and is scanned normally.
       */
      reason: "network_namespace" | "platform_unsupported";
    };
