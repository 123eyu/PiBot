import { abortable } from "@pibot/brain/kit";

interface Hold {
  taskId: string;
  groupId: string | undefined;
  /** Settles when every earlier step taking turns in the same folder has ended. */
  prior: Promise<void>;
  release(): void;
  waiting: boolean;
}

/**
 * Plan steps that take turns in one shared folder run one after another. Flipping the task to
 * serial alone did not do it: both sibling runs had already started, and the folder write lock
 * only stopped the second at its first write (10 min wait), after it had read the folder while
 * the first was changing it. The turn is taken when prepare decides to take turns and is given
 * back when that run settles, so the order is the order the steps prepared in.
 */
export class StepTurns {
  private readonly folders = new Map<string, { tail: Promise<void>; reason: string }>();
  private readonly holds = new Map<string, Hold>();
  constructor(private readonly changed: (groupId: string) => void) {}

  /** Joins the folder's line; a run already in a line keeps its place. */
  join(runId: string, taskId: string, groupId: string | undefined, folder: string, reason: string) {
    if (this.holds.has(runId)) return;
    const prior = this.folders.get(folder)?.tail ?? Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = Promise.all([prior, mine]).then(() => {});
    this.folders.set(folder, { tail, reason });
    this.holds.set(runId, { taskId, groupId, prior, release, waiting: false });
    void tail.then(() => {
      if (this.folders.get(folder)?.tail === tail) this.folders.delete(folder);
    });
  }

  /** Why the folder's current line takes turns, while one exists. */
  reason(folder: string) {
    return this.folders.get(folder)?.reason;
  }

  async wait(runId: string, signal: AbortSignal) {
    const hold = this.holds.get(runId);
    if (!hold) return;
    hold.waiting = true;
    if (hold.groupId) this.changed(hold.groupId);
    try {
      await abortable(hold.prior, signal);
    } catch (error) {
      // A stopped waiter never wrote anything; the steps behind it need not wait for its settle.
      this.release(runId);
      throw error;
    } finally {
      hold.waiting = false;
      if (hold.groupId) this.changed(hold.groupId);
    }
  }

  waiting(taskId: string) {
    for (const hold of this.holds.values()) if (hold.taskId === taskId && hold.waiting) return true;
    return false;
  }

  release(runId: string) {
    const hold = this.holds.get(runId);
    if (!hold) return;
    this.holds.delete(runId);
    hold.release();
  }

  dispose() {
    for (const runId of [...this.holds.keys()]) this.release(runId);
  }
}
