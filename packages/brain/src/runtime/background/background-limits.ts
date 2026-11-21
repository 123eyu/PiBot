/** One timer per owned command; promotion retains the original start timestamp. */
export class BackgroundLimits {
  private readonly jobs = new Map<
    string,
    { startedAt: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private readonly active = new Set<Promise<void>>();
  private closed = false;
  constructor(
    private readonly ports: {
      minutes(): number;
      expire(id: string): Promise<void>;
      failed(id: string): void;
    },
  ) {}

  add(id: string, startedAt: string) {
    if (this.closed) return;
    this.jobs.set(id, { startedAt: Date.parse(startedAt) });
    this.schedule(id);
  }
  remove(id: string) {
    clearTimeout(this.jobs.get(id)?.timer);
    this.jobs.delete(id);
  }
  refresh() {
    for (const id of this.jobs.keys()) this.schedule(id);
  }
  private schedule(id: string, retry?: number) {
    const job = this.jobs.get(id);
    if (!job || this.closed) return;
    clearTimeout(job.timer);
    job.timer = setTimeout(
      () => {
        const work = this.ports
          .expire(id)
          .catch(() => {
            this.ports.failed(id);
            this.schedule(id, 30_000);
          })
          .finally(() => this.active.delete(work));
        this.active.add(work);
      },
      retry ?? Math.max(1, job.startedAt + this.ports.minutes() * 60_000 - Date.now()),
    );
    job.timer.unref?.();
  }
  async dispose() {
    this.closed = true;
    for (const id of this.jobs.keys()) this.remove(id);
    await Promise.allSettled([...this.active]);
  }
}
