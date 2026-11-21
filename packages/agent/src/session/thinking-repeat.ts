/**
 * DeepSeek flash occasionally loops inside its reasoning and repeats one passage until the whole
 * output budget is gone (2026-11-05: one run burned 32,768 tokens on the same paragraph). A cheap
 * tail check turns that into a normal `length` cut, so the runtime continues instead of failing.
 *
 * The guard keeps the recent text only in memory and drops everything older than the window; no
 * content is logged, stored or sent anywhere.
 */

/** Text kept for the check. Bounds both memory and the cost of one scan. */
const WINDOW = 6_000;
/** Shortest fragment worth stopping for: a 200-character block repeated three times is a loop. */
const FRAGMENT = 200;
/** How often the same block has to appear consecutively. */
const REPEATS = 3;
/**
 * Characters between two scans. Small enough to notice the third copy right away, large enough
 * that a 32,000-token thought costs a few hundred bounded scans instead of one per delta.
 */
const CHECK_EVERY = 64;
/** Earlier candidates examined per scan; the nearest match wins, deeper ones only if it was short. */
const CANDIDATES = 4;

export class ThinkingRepeatGuard {
  private text = "";
  private pending = 0;
  private repeated = false;

  /** Returns true once a loop is detected; later deltas stay true and cost nothing. */
  push(delta: string): boolean {
    if (this.repeated) return true;
    this.text += delta;
    if (this.text.length > WINDOW) this.text = this.text.slice(-WINDOW);
    this.pending += delta.length;
    // Scanning per delta would be O(n²) inside one response; a bounded scan per few dozen
    // characters is enough to cut a loop early.
    if (this.pending < CHECK_EVERY) return false;
    this.pending = 0;
    this.repeated = repeatsAtTail(this.text);
    return this.repeated;
  }
}

/**
 * Looking only at the tail keeps the scan cheap and never misses a live loop: while the model
 * repeats itself, the newest text is always inside the repeated block. `probe` locates candidate
 * periods; a period shorter than the fragment is scaled up to the smallest multiple that reaches
 * it, because a p-periodic tail is also q-periodic for any multiple q of p.
 */
function repeatsAtTail(text: string): boolean {
  const probe = text.slice(-FRAGMENT);
  let from = text.length - FRAGMENT - 1;
  for (let found = 0; found < CANDIDATES && from > 0; found += 1) {
    const at = text.lastIndexOf(probe, from);
    if (at < 0) return false;
    const distance = text.length - FRAGMENT - at;
    const period = distance >= FRAGMENT ? distance : distance * Math.ceil(FRAGMENT / distance);
    if (period * REPEATS <= text.length) {
      const block = text.slice(-period);
      if (
        text.slice(-2 * period, -period) === block &&
        text.slice(-3 * period, -2 * period) === block
      )
        return true;
    }
    from = at - 1;
  }
  return false;
}
