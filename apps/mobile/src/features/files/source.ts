import { type PreviewKind, previewKind } from "@pibot/protocol";
import { z } from "zod";

/** The two read authorities the computer accepts (same as its preview pane). */
export type FileSource =
  | { attachmentId: string; messageId: string }
  | { runId: string; path: string };
export type PhoneView = "image" | "text" | "markdown" | "office" | "desktop";

export function sourceKey(source: FileSource) {
  return "runId" in source
    ? `run:${source.runId}:${source.path}`
    : `attachment:${source.attachmentId}`;
}
/** What the phone can show for a file name; PDF and SVG stay on the computer (see notes). */
export function phoneView(name: string): { kind?: PreviewKind; view: PhoneView } {
  const kind = previewKind(name);
  if (kind === "image") return { kind, view: "image" };
  if (kind === "markdown") return { kind, view: "markdown" };
  if (kind === "code") return { kind, view: "text" };
  if (kind === "docx" || kind === "xlsx" || kind === "pptx") return { kind, view: "office" };
  return { kind, view: "desktop" };
}
export function extensionOf(name: string) {
  return name.toLowerCase().split(".").pop() ?? "bin";
}

const ParamsSchema = z.union([
  z.strictObject({ name: z.string().min(1).max(4096), a: z.uuid(), m: z.uuid() }),
  z.strictObject({
    name: z.string().min(1).max(4096),
    run: z.uuid(),
    path: z.string().min(1).max(4096),
  }),
]);
/** expo-router query of /file; encodes either source without putting it in a path segment. */
export function fileHref(source: FileSource, name: string) {
  const params =
    "runId" in source
      ? { name, run: source.runId, path: source.path }
      : { name, a: source.attachmentId, m: source.messageId };
  return { pathname: "/file" as const, params };
}
export function parseFileParams(input: unknown): { source: FileSource; name: string } | undefined {
  const parsed = ParamsSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  return "run" in value
    ? { name: value.name, source: { runId: value.run, path: value.path } }
    : { name: value.name, source: { attachmentId: value.a, messageId: value.m } };
}
