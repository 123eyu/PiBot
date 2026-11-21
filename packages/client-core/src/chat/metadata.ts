import { type Bot, canonicalImageModelId, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { readMainBot } from "./main-bot.ts";
import type { ChatSession } from "./session.ts";

/** A slow start (brain ready after ~25 s under load) answers its first catalog reads late. */
const STARTUP_PATIENCE_MS = 60_000;
const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

/**
 * Failures that say "not answered yet" rather than "the brain answered no": a deadline, a busy
 * queue, a port replaced mid-read, or a lane cancelled by its own 30 s deadline. A real answer
 * (internal, invalid params, a missing Bot) is shown at once.
 */
function notAnsweredYet(error: unknown) {
  if (error instanceof RpcError)
    return (
      error.code === RpcErrorCodes.timeout ||
      error.code === RpcErrorCodes.closed ||
      error.code === RpcErrorCodes.busy
    );
  return (
    (error instanceof Error || error instanceof DOMException) &&
    (error.name === "AbortError" || error.message === "Read capacity reached")
  );
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      if (signal.aborted) reject(signal.reason);
      else resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Retries unanswered reads with backoff until the patience window closes, then rethrows. */
async function patiently<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  waiting: () => void,
  started = Date.now(),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      signal.throwIfAborted();
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] as number;
      if (!notAnsweredYet(error) || Date.now() - started + delay > STARTUP_PATIENCE_MS) throw error;
      waiting();
      await pause(delay, signal);
    }
  }
}

export async function readBot(this: ChatSession, signal: AbortSignal) {
  signal.throwIfAborted();
  if (this.target.botId) {
    try {
      const bot = (
        await this.reads.read(
          `bot:${this.target.botId}`,
          (read) =>
            this.peer.call(
              "bots.profile",
              { botId: this.target.botId as string },
              { signal: read },
            ),
          signal,
        )
      ).bot;
      signal.throwIfAborted();
      if (bot.id !== this.target.botId) throw new Error("Bot target mismatch");
      return bot;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof RpcError) || error.code !== RpcErrorCodes.methodNotFound) throw error;
    }
  } else return readMainBot(this.peer, signal);
  const bots = await this.reads.read(
    "bots:legacy",
    (read) => this.peer.call("bots.list", { limit: 200 }, { signal: read }),
    signal,
  );
  signal.throwIfAborted();
  return bots.find((item) => item.id === this.target.botId);
}

export async function refreshMetadata(this: ChatSession, confirmedBot?: Bot) {
  if (this.disposed) return;
  this.metadataRead?.abort();
  const read = new AbortController();
  this.metadataRead = read;
  const version = ++this.metadataVersion;
  const botVersion = this.botVersion;
  const previous = this.state.bot;
  this.patch({ metadataLoading: true, metadataError: false, metadataRetrying: false });
  try {
    // Read the selected catalog for the confirmed save, without replacing it with an older profile.
    const signal = AbortSignal.any([read.signal, this.lifetime.signal]);
    const started = Date.now();
    // Only this refresh may say it is waiting; a newer one owns the flag from its first patch.
    const waiting = () => {
      if (this.metadataRead === read && !this.state.metadataRetrying)
        this.patch({ metadataRetrying: true });
    };
    this.identityRead = confirmedBot
      ? Promise.resolve(confirmedBot)
      : patiently(() => this.readBot(signal), signal, waiting, started);
    // Most Bots are text Bots: read the model list beside the identity, not after it, so it joins
    // the catalog read the same mount starts instead of following it as a second request.
    const readModels = () =>
      patiently(
        () =>
          this.reads.read(
            "models:available",
            (signal) => this.peer.call("models.list", { availableOnly: true }, { signal }),
            signal,
          ),
        signal,
        waiting,
        started,
      );
    const early = (confirmedBot ?? previous)?.category === "image" ? undefined : readModels();
    // Unused if the Bot turns out to be an image Bot; the finally block releases the lane.
    early?.catch(() => undefined);
    const bot = await this.identityRead;
    signal.throwIfAborted();
    if (version !== this.metadataVersion || botVersion !== this.botVersion) return;
    // Identity is useful immediately; slow catalogs must not hold history/folders hostage.
    this.patch({ bot, metadataError: !bot });
    const images =
      bot?.category === "image" && bot.modelProvider && bot.modelId
        ? await patiently(
            () =>
              this.reads.read(
                `images:${bot.modelProvider}:${bot.modelId}`,
                (signal) =>
                  this.peer.call(
                    "models.images",
                    {
                      availableOnly: true,
                      selected: {
                        provider: bot.modelProvider as string,
                        id: bot.modelId as string,
                      },
                      limit: 1,
                    },
                    { signal },
                  ),
                signal,
              ),
            signal,
            waiting,
            started,
          )
        : [];
    const image = images.find(
      (model) =>
        model.provider === bot?.modelProvider &&
        model.id === canonicalImageModelId(bot.modelProvider as string, bot.modelId as string),
    );
    const models = bot?.category === "image" ? [] : await (early ?? readModels());
    if (this.disposed || read.signal.aborted || version !== this.metadataVersion) return;
    if (botVersion !== this.botVersion) {
      void this.refreshMetadata();
      return;
    }
    this.patch({ models, imageModels: image ? [image] : [], bot, metadataError: !bot });
    // The saved Bot is only known after this read; a switch to a smaller window is the
    // one moment the estimate is worth paying for. The first read is no switch: the history load
    // asks once it has the topic, and asking here too doubled a session read per open.
    if (
      previous &&
      (previous.modelProvider !== bot?.modelProvider || previous.modelId !== bot?.modelId)
    )
      void this.checkContextHint();
  } catch {
    if (!read.signal.aborted && version === this.metadataVersion && botVersion === this.botVersion)
      this.patch({ metadataError: true, metadataRetrying: false });
  } finally {
    read.abort();
    if (this.metadataRead === read) {
      this.metadataRead = undefined;
      this.patch({ metadataLoading: false, metadataRetrying: false });
    }
  }
}
