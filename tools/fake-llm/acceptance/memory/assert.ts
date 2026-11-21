export class ProbeFailure extends Error {}
export function requireThat(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new ProbeFailure(reason);
}
