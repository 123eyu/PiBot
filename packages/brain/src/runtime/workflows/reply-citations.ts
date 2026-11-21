import type { DeliverySources } from "./delivery-citations.ts";
import { markdownOutline } from "./delivery-citations.ts";
import { observedWebReference } from "./delivery-reference.ts";

/** Reuse observed-source identity, with no file candidates, network, or new source authority. */
export function replyCitationFacts(text: string, sources: DeliverySources, signal: AbortSignal) {
  signal.throwIfAborted();
  const urls = new Set<string>();
  let incomplete = !!sources.incomplete || text.length > 100_000;
  for (const match of markdownOutline(text.slice(0, 100_000))
    .join("\n")
    .matchAll(/https?:\/\/[^\s<>`]+/giu)) {
    if (urls.size === 100) {
      incomplete = true;
      break;
    }
    urls.add(match[0]);
  }
  let unread = 0;
  for (const url of urls) {
    if (!observedWebReference(url, sources.webDigests).source) unread++;
  }
  return unread || incomplete ? { unread, incomplete } : undefined;
}

export async function checkReplyCitations(
  text: string | readonly string[],
  sources: DeliverySources,
  signal: AbortSignal,
) {
  // The final stream reply may already be the persisted message body.
  const content =
    typeof text === "string" ? text : [...new Set(text.map((part) => part.trim()))].join("\n");
  return replyCitationFacts(content, sources, signal);
}
