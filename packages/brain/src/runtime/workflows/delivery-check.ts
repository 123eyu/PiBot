import type { Deliverable, DeliveryItem, SkillContract } from "@pibot/protocol-base";
import { extractAttachment } from "../../conversations/attachments/extract-attachment.ts";
import type { OfficePort } from "../media/office-port.ts";
import { type DeliverySources, emptySources } from "./delivery-citations.ts";
import { type DeliveryRead, extraDeliveryCheck } from "./delivery-extra.ts";
import { validAcademicReferences, validOutputName } from "./delivery-format.ts";
import { deliveryFile } from "./delivery-path.ts";
import { missingDeliverySections } from "./delivery-sections.ts";
import { reportVerdict } from "./delivery-verdict.ts";

export type DeliveryContract = Pick<SkillContract, "deliverables" | "acceptance"> & {
  /** Only inferred role contracts may waive the default directory for a user-specified location. */
  defaultOutputDirectory?: boolean;
};

/** Local, bounded checks share one read per deliverable. Cancellation keeps resource ownership. */
export async function checkDelivery(
  contract: DeliveryContract,
  folder: string,
  office: OfficePort | undefined,
  signal: AbortSignal,
  sources: DeliverySources = emptySources(),
): Promise<DeliveryItem[]> {
  const deliverables = new Map(contract.deliverables.map((item) => [item.id, item]));
  const reads = new Map<string, Promise<DeliveryRead>>();
  const items: DeliveryItem[] = [];
  for (const acceptance of contract.acceptance) {
    signal.throwIfAborted();
    const deliverable = acceptance.deliverable
      ? deliverables.get(acceptance.deliverable)
      : undefined;
    const base = {
      id: acceptance.id,
      check: acceptance.check,
      deliverable: deliverable?.path ?? null,
      text: acceptance.text ?? null,
      missing: [] as string[],
    };
    if (acceptance.check === "manual" || !deliverable) {
      items.push({ ...base, status: "manual", reason: "needs_human" });
      continue;
    }
    const content = acceptance.check !== "exists" && acceptance.check !== "fileNaming";
    const key = `${deliverable.id}:${content}`;
    let pending = reads.get(key);
    if (!pending) {
      pending = readDeliverable(folder, deliverable, content, office, signal, sources.access);
      reads.set(key, pending);
    }
    const file = await pending;
    if (file.state === "missing" || file.state === "empty") {
      items.push({
        ...base,
        status: "fail",
        reason: file.state === "missing" ? "missing_file" : "empty_file",
      });
      continue;
    }
    if (acceptance.check === "fileNaming") {
      const valid = validOutputName(
        folder,
        deliverable.path,
        contract.defaultOutputDirectory ?? true,
        sources.access?.paths,
      );
      items.push({
        ...base,
        status: valid ? "pass" : "fail",
        reason: valid ? null : "invalid_output_name",
      });
      continue;
    }
    if (acceptance.check === "exists") {
      items.push({ ...base, status: "pass", reason: null });
      continue;
    }
    if (file.state === "unreadable" || file.text === undefined) {
      items.push({ ...base, status: "manual", reason: "unreadable" });
      continue;
    }
    if (
      (acceptance.check === "hasChart" &&
        kindOf(deliverable) !== "md" &&
        file.hasChart === undefined) ||
      (acceptance.check === "tableColumns" &&
        kindOf(deliverable) === "xlsx" &&
        file.columns === undefined)
    ) {
      items.push({ ...base, status: "manual", reason: "unreadable" });
      continue;
    }
    if (acceptance.check === "verdict") {
      const verdict = reportVerdict(file.text);
      items.push(
        verdict
          ? { ...base, status: "pass", reason: null, verdict }
          : { ...base, status: "fail", reason: "verdict_missing" },
      );
      continue;
    }
    if (acceptance.check === "gbt7714") {
      const valid = validAcademicReferences(file.text);
      items.push({
        ...base,
        status: valid ? "pass" : "fail",
        reason: valid ? null : "invalid_citation_format",
      });
      continue;
    }
    if (acceptance.check === "sections") {
      const missing = missingDeliverySections(file.text, deliverable, kindOf(deliverable));
      items.push(
        missing.length
          ? { ...base, status: "fail", reason: "missing_sections", missing: missing.slice(0, 10) }
          : { ...base, status: "pass", reason: null },
      );
    } else
      items.push({
        ...base,
        ...(await extraDeliveryCheck(acceptance, deliverable, file, folder, sources, signal)),
      });
  }
  return items;
}

async function readDeliverable(
  folder: string,
  deliverable: Deliverable,
  content: boolean,
  office: OfficePort | undefined,
  parent: AbortSignal,
  access?: import("../../resources/workplaces/workspace-files.ts").WorkspaceFileAccess,
): Promise<DeliveryRead> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(15_000)]);
  try {
    const kind = kindOf(deliverable);
    const file = await deliveryFile(
      folder,
      deliverable.path,
      signal,
      content ? (kind === "md" ? 2 * 1024 * 1024 : 20 * 1024 * 1024) : undefined,
      access,
    );
    if (!file) return { state: "missing" };
    if (!file.size) return { state: "empty" };
    if (!content) return { state: "ok" };
    if (!file.data) return { state: "unreadable" };
    try {
      if ((kind === "docx" || kind === "xlsx") && office?.delivery)
        return { state: "ok", ...(await office.delivery(file.data, kind, signal)) };
      if (kind === "docx")
        return { state: "ok", text: (await extractAttachment(file.data, false, signal)).text };
      if (kind === "xlsx" || kind === "pptx")
        return office
          ? { state: "ok", text: (await office.extract(file.data, kind, signal)).text }
          : { state: "unreadable" };
      const text = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
      return text.includes("\0") ? { state: "unreadable" } : { state: "ok", text };
    } catch {
      // Content decoding can fail on either target; it is not a successful program check.
      parent.throwIfAborted();
      return { state: "unreadable" };
    }
  } catch (error) {
    parent.throwIfAborted();
    if (access?.remote) throw error;
    return error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? { state: "missing" }
      : { state: "unreadable" };
  }
}
export function kindOf(deliverable: Deliverable): Exclude<Deliverable["kind"], "any"> {
  if (deliverable.kind !== "any") return deliverable.kind;
  const extension = deliverable.path.split(".").at(-1)?.toLowerCase();
  return extension === "docx" || extension === "xlsx" || extension === "pptx" ? extension : "md";
}
export function deliveryStatus(items: readonly DeliveryItem[]): "passed" | "failed" | "manual" {
  if (items.some((item) => item.status === "fail")) return "failed";
  return items.some((item) => item.status === "manual") ? "manual" : "passed";
}
