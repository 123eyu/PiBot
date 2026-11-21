import type { MethodTable, Params, Result } from "@pibot/protocol-base";

/**
 * A typed brain → background-process call port for one host method table. The desktop
 * implements it with the host peer; a server brain without a desktop simply leaves it unset.
 * Every call takes a signal so a stopped run stops waiting for the host.
 */
export interface HostCall<M extends MethodTable> {
  call<K extends keyof M & string>(
    method: K,
    params: Params<M, K>,
    signal: AbortSignal,
  ): Promise<Result<M, K>>;
}
