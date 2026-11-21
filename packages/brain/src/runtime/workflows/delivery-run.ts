// The existing run owns bounded delivery correction, including injected group handoff checks.
import type { Logger } from "@pibot/observability";
import type { DeliveryItem, ReceiptDelivery } from "@pibot/protocol-base";
import type { OfficePort } from "../media/office-port.ts";
import { checkDelivery, type DeliveryContract, deliveryStatus } from "./delivery-check.ts";
import type { DeliverySources } from "./delivery-citations.ts";
import type { WorkflowRun } from "./workflow-prepare.ts";
import { deliveryFixText } from "./workflow-text.ts";

/** The whole check (all deliverables) is local and should take milliseconds; this is a backstop. */
const CHECK_MS = 30_000;

/**
 * Delivery checks of one workflow run, plugged into the run's existing follow-up loop next
 * to the automatic code check (same session, same budget, same reply). `next` checks after the
 * model stops and returns the fix prompt (only the missing items) while fix rounds remain;
 * `record` is what the run stores on its reply for the receipt. Never discards artifacts.
 */
export class DeliveryRun {
  private rounds = 0;
  private items?: DeliveryItem[];
  private durationMs = 0;
  private folder?: string;
  /** True until a check ran after the model's latest turn. */
  private stale = true;
  constructor(
    private readonly deps: {
      workflow: Pick<WorkflowRun, "name" | "version" | "contract">;
      contract?: (signal: AbortSignal) => Promise<DeliveryContract>;
      check?: (signal: AbortSignal) => Promise<{ items: DeliveryItem[]; folder: string }>;
      folder: string;
      office(): OfficePort | undefined;
      language: "zh" | "en";
      signal: AbortSignal;
      logger: Logger;
      runId: string;
      botId: string;
      sources(): DeliverySources;
    },
  ) {}

  private get maxRounds() {
    return Math.min(2, this.deps.workflow.contract.maxFixRounds);
  }

  private async check(): Promise<DeliveryItem[]> {
    const started = performance.now();
    const signal = AbortSignal.any([this.deps.signal, AbortSignal.timeout(CHECK_MS)]);
    const checked = await this.deps.check?.(signal);
    const items = checked
      ? checked.items
      : await checkDelivery(
          (await this.deps.contract?.(signal)) ?? this.deps.workflow.contract,
          this.deps.folder,
          this.deps.office(),
          signal,
          this.deps.sources(),
        );
    this.folder = checked?.folder ?? this.deps.folder;
    this.durationMs = Math.round(performance.now() - started);
    this.items = items;
    this.stale = false;
    // Codes and counts only: no paths, section names or content in logs.
    this.deps.logger.info(
      JSON.stringify({
        module: "workflow",
        event: "delivery_checked",
        botId: this.deps.botId,
        runId: this.deps.runId,
        status: deliveryStatus(items),
        failed: items.filter((item) => item.status === "fail").length,
        failures: items
          .filter((item) => item.status === "fail")
          .slice(0, 10)
          .map((item) => ({ check: item.check, reason: item.reason ?? "unknown" })),
        round: this.rounds,
        durationMs: this.durationMs,
      }),
    );
    return items;
  }

  /** After the model stopped: the fix prompt when the check failed and a round is left. */
  async next(): Promise<string | undefined> {
    if (!this.deps.check && !this.deps.contract && !this.deps.workflow.contract.acceptance.length)
      return undefined;
    const items = await this.check();
    if (deliveryStatus(items) !== "failed" || this.rounds >= this.maxRounds) return undefined;
    this.rounds++;
    this.stale = true;
    return deliveryFixText(
      items,
      this.folder ?? this.deps.folder,
      this.rounds,
      this.maxRounds,
      this.deps.language,
    );
  }

  /** The stored result; checks once more only when the model changed something since the last one. */
  async record(): Promise<ReceiptDelivery | undefined> {
    if (
      this.stale &&
      (this.deps.check || this.deps.contract || this.deps.workflow.contract.acceptance.length)
    )
      await this.check();
    const items = this.items ?? [];
    if ((this.deps.check || this.deps.contract) && !items.length) return undefined;
    return {
      workflow: this.deps.workflow.name,
      version: this.deps.workflow.version,
      status: deliveryStatus(items),
      fixRounds: this.rounds,
      maxFixRounds: this.maxRounds,
      durationMs: this.durationMs,
      folder: (this.folder ?? this.deps.folder) || null,
      // Report excerpts belong only to the redacted handoff/progress path, never raw receipt usage.
      items: items.slice(0, 20).map(({ verdict: _verdict, ...item }) => item),
    };
  }
}
