import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ComputerRunContext } from "@pibot/brain/kit";
import {
  type ComputerApp,
  type ComputerStep,
  type ComputerStepAction,
  type ComputerStepHandoff,
  type ComputerStepMethod,
  type ComputerStepPage,
  type ComputerStepResult,
  IdSchema,
  IMAGE_LIMIT,
  type ImageContent,
  RpcError,
  RpcErrorCodes,
  THUMBNAIL_BYTES,
  type ThumbnailContentSchema,
} from "@pibot/computer-use-contract/full";
import { ComputerSettingsRepo, ComputerStepsRepo } from "@pibot/storage";
import type { z } from "zod";
import type { ComputerContext } from "../../context.ts";

const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_SWEEP_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXTENSIONS: Record<string, "jpg" | "png" | "webp"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MIMES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
type ThumbnailContent = z.infer<typeof ThumbnailContentSchema>;

export interface StepInput {
  toolCallId: string;
  app: ComputerApp;
  method: ComputerStepMethod;
  stage: "background" | "foreground";
  /** Element description or coordinates; never typed text or field values. */
  target: string;
  result: ComputerStepResult;
  image?: ImageContent;
  /** The action as data, phrased by the UI in its language (`target` stays a fallback). */
  action?: ComputerStepAction;
  /** The page a Bot browser step left the Bot on. */
  page?: ComputerStepPage;
  /** The step waits on (or waited on) a "come help for a moment" card. */
  handoff?: ComputerStepHandoff;
}

/**
 * Operation steps: one row per action with an optional screenshot file under the
 * Bot directory. The renderer only receives references and fetches a thumbnail on demand.
 * Owner: ComputerContext. `dispose` stops the retention sweep.
 */
export class ComputerSteps {
  readonly repo: ComputerStepsRepo;
  private readonly settings: ComputerSettingsRepo;
  private timer?: ReturnType<typeof setTimeout>;
  private sweeping?: Promise<void>;

  constructor(private readonly local: ComputerContext) {
    this.repo = new ComputerStepsRepo(local.deps.db);
    this.settings = new ComputerSettingsRepo(local.deps.db);
  }

  private screenshotDir(botId: string) {
    return join(this.local.deps.dataDir, "bots", IdSchema.parse(botId), "computer", "screenshots");
  }

  /** Writes a step's screenshot under the Bot directory; returns its relative path. */
  private async saveImage(botId: string, image: ImageContent | undefined) {
    const extension = image ? EXTENSIONS[image.mimeType] : undefined;
    if (!image || !extension) return null;
    const dir = this.screenshotDir(botId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const name = `${randomUUID()}.${extension}`;
    await writeFile(join(dir, name), Buffer.from(image.data, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    return `computer/screenshots/${name}`;
  }

  private action(action: ComputerStepAction | undefined) {
    if (!action) return undefined;
    return {
      ...action,
      ...(action.subject !== undefined
        ? { subject: plain(this.local.deps.redactor.redact(action.subject), 300) }
        : {}),
    };
  }

  /** Records a step; failures are logged, never turned into tool failures. */
  async record(context: ComputerRunContext, input: StepInput): Promise<ComputerStep | undefined> {
    const redact = (text: string) => this.local.deps.redactor.redact(text);
    try {
      const screenshotPath = await this.saveImage(context.botId, input.image);
      const action = this.action(input.action);
      const step = this.repo.create({
        botId: context.botId,
        runId: context.runId,
        toolCallId: plain(input.toolCallId, 200) || "tool",
        app: { id: input.app.id, name: plain(input.app.name, 200) || input.app.id },
        method: input.method,
        stage: input.stage,
        target: plain(this.local.deps.redactor.redact(input.target), 500),
        result: input.result,
        screenshotPath,
        ...(action ? { action } : {}),
        ...(input.page
          ? {
              page: {
                url: plain(redact(input.page.url), 2048),
                title: plain(redact(input.page.title), 500),
              },
            }
          : {}),
        ...(input.handoff ? { handoff: input.handoff } : {}),
      });
      this.local.deps.peer.emit("computer.step", { step });
      this.local.observeStep(context, step);
      return step;
    } catch {
      this.local.deps.logger.warn(`Computer step not recorded bot=${context.botId}`);
      return undefined;
    }
  }

  /**
   * The row that showed "waiting for you" takes the call's outcome (one row per step,
   * as the design shows). Failures are logged like `record`.
   */
  async finishHandoff(
    context: ComputerRunContext,
    stepId: string,
    input: Pick<StepInput, "stage" | "target" | "result" | "image" | "action"> & {
      handoff: ComputerStepHandoff;
    },
  ): Promise<ComputerStep | undefined> {
    try {
      const action = this.action(input.action);
      const step = this.repo.finishHandoff(stepId, {
        handoff: input.handoff,
        result: input.result,
        stage: input.stage,
        target: plain(this.local.deps.redactor.redact(input.target), 500),
        screenshotPath: await this.saveImage(context.botId, input.image),
        ...(action ? { action } : {}),
      });
      if (step) {
        this.local.deps.peer.emit("computer.step", { step });
        this.local.observeStep(context, step);
      }
      return step;
    } catch {
      this.local.deps.logger.warn(`Computer step not updated bot=${context.botId}`);
      return undefined;
    }
  }

  private async file(stepId: string): Promise<{ path: string; name: string; botId: string }> {
    const found = this.repo.screenshotPath(stepId);
    if (!found) throw new RpcError(RpcErrorCodes.invalidParams, "computer_screenshot_missing");
    const name = found.path.slice("computer/screenshots/".length);
    const dir = this.screenshotDir(found.botId);
    const path = join(dir, name);
    // Bot directories are brain-owned; refuse anything redirected out of them.
    if ((await realpath(path).catch(() => "")) !== resolve(path) || !(await lstat(path)).isFile())
      throw new RpcError(RpcErrorCodes.invalidParams, "computer_screenshot_missing");
    return { path, name, botId: found.botId };
  }

  async view(stepId: string, signal: AbortSignal): Promise<ImageContent> {
    const { path, name } = await this.file(stepId);
    const bytes = await readFile(path, { signal });
    if (bytes.length > IMAGE_LIMIT)
      throw new RpcError(RpcErrorCodes.invalidParams, "computer_screenshot_missing");
    return { type: "image", data: bytes.toString("base64"), mimeType: mime(name) };
  }

  async thumbnail(stepId: string, signal: AbortSignal): Promise<ThumbnailContent> {
    const { path, name, botId } = await this.file(stepId);
    const host = this.local.deps.host.attachments?.stepThumbnail;
    if (host) return host({ botId, file: name }, signal);
    // A host without an image toolkit (server brain) can still show small originals.
    const bytes = await readFile(path, { signal });
    const type = mime(name);
    if (bytes.length > THUMBNAIL_BYTES || type === "image/webp")
      throw new RpcError(RpcErrorCodes.unsupported, "computer_thumbnail_unavailable");
    return { type: "image", data: bytes.toString("base64"), mimeType: type };
  }

  /** Retention sweep (7 days by default, `computer.settings`). */
  startSweep() {
    this.timer = setTimeout(
      () => {
        this.sweeping = this.sweep().finally(() => {
          this.sweeping = undefined;
          if (!this.local.shutdown.signal.aborted) this.startSweep();
        });
      },
      this.timer ? SWEEP_EVERY_MS : FIRST_SWEEP_MS,
    );
    this.timer.unref?.();
  }

  async sweep() {
    const signal = this.local.shutdown.signal;
    const days = this.settings.get().screenshotRetentionDays;
    const before = new Date(Date.now() - days * DAY_MS);
    try {
      for (;;) {
        signal.throwIfAborted();
        const batch = this.repo.takeExpiredScreenshots(before);
        for (const row of batch)
          await rm(join(this.screenshotDir(row.botId), row.path.split("/").pop() as string), {
            force: true,
          });
        if (batch.length < 200) break;
      }
      // Files whose row was already cleared (crash between the two steps) or never written.
      const bots = await readdir(join(this.local.deps.dataDir, "bots")).catch(() => []);
      for (const botId of bots) {
        if (!IdSchema.safeParse(botId).success) continue;
        const dir = this.screenshotDir(botId);
        for (const name of await readdir(dir).catch(() => [] as string[])) {
          signal.throwIfAborted();
          const info = await lstat(join(dir, name)).catch(() => undefined);
          if (info?.isFile() && info.mtimeMs < before.getTime())
            await rm(join(dir, name), { force: true });
        }
      }
    } catch {
      if (!signal.aborted) this.local.deps.logger.warn("Computer screenshot sweep failed");
    }
  }

  async dispose() {
    clearTimeout(this.timer);
    await this.sweeping;
  }
}

function mime(name: string): ThumbnailContent["mimeType"] | "image/webp" {
  return MIMES[(name.split(".").pop() ?? "jpg") as keyof typeof MIMES] ?? "image/jpeg";
}
/** Step fields are shown in the UI: one line, no control characters. */
function plain(text: string, max: number) {
  return text
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim()
    .slice(0, max);
}
