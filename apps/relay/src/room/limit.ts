// Intentionally ephemeral: DO hibernation/eviction resets the fallback budget.
export class MinuteLimit {
  private minute = -1;
  private count = 0;
  take(limit: number, now = Date.now()) {
    const minute = Math.floor(now / 60_000);
    if (minute !== this.minute) {
      this.minute = minute;
      this.count = 0;
    }
    if (this.count >= limit) return false;
    this.count++;
    return true;
  }
}
