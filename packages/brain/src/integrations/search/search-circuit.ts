import { DuckDuckGoError, isProxyFailure } from "@pibot/execution";

export class SearchCooldownError extends DuckDuckGoError {}

/** Routing state never becomes a consent/configuration snapshot or survives a brain restart. */
export class SearchCircuit {
  private failures = 0;
  private until = 0;
  private probing = false;
  private generation = 0;
  private reason: "blocked" | "unavailable" | "dns_blocked" = "unavailable";
  constructor(private readonly now: () => number) {}

  cooling() {
    return this.probing || this.now() < this.until;
  }
  failure() {
    return this.cooling() ? this.reason : undefined;
  }
  reset() {
    this.generation++;
    this.failures = this.until = 0;
    this.probing = false;
  }
  assertReady() {
    if (this.cooling()) throw new SearchCooldownError(this.reason);
  }
  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    this.assertReady();
    const generation = this.generation;
    const probe = this.failures > 0;
    if (probe) this.probing = true;
    try {
      const value = await action();
      signal.throwIfAborted();
      if (generation === this.generation) this.reset();
      return value;
    } catch (error) {
      if (
        generation === this.generation &&
        !signal.aborted &&
        !isProxyFailure(error) &&
        error instanceof DuckDuckGoError &&
        error.reason !== "structure"
      ) {
        this.reason = error.reason;
        this.failures = Math.min(5, this.failures + 1);
        this.until = this.now() + 30 * 60_000 * 2 ** (this.failures - 1);
      }
      throw error;
    } finally {
      if (generation === this.generation && probe) this.probing = false;
    }
  }
}
