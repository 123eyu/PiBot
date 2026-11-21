import type { BinaryToolRun, PreparedTool } from "@pibot/brain/kit";
import type { OfficeContent } from "@pibot/office-contract/full";
import type { OfficeOperation } from "@pibot/protocol-base/office-ooxml";
import { OfficeError } from "./errors.ts";

/** Each local image is a derived read, never authority inherited from the output document. */
export async function readOfficeImages(
  run: BinaryToolRun,
  prepared: PreparedTool,
  content: OfficeContent | OfficeOperation[],
  signal: AbortSignal,
): Promise<Record<string, Uint8Array>> {
  const paths = [
    ...new Set(
      !Array.isArray(content) && content.kind === "docx"
        ? content.blocks.flatMap((block) =>
            block.type === "paragraph" && block.image ? [block.image.path] : [],
          )
        : !Array.isArray(content) && content.kind === "pptx"
          ? content.slides.flatMap((slide) =>
              (slide.objects ?? []).flatMap((object) =>
                object.type === "image" ? [object.path] : [],
              ),
            )
          : [],
    ),
  ];
  const operations = Array.isArray(content)
    ? content
    : content.kind === "docx"
      ? (content.word?.operations ?? [])
      : [];
  const operationPaths = operations.flatMap((op) =>
    op.op === "word_image" ? [op.image.path] : [],
  );
  const template =
    !Array.isArray(content) && content.kind === "pptx" ? content.template : undefined;
  const reads = [...new Set([...paths, ...operationPaths, ...(template ? [template.path] : [])])];
  const imagePaths = new Set([...paths, ...operationPaths]);
  if (imagePaths.size > 10) throw new OfficeError("office_invalid");
  const images: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  for (const path of reads) {
    signal.throwIfAborted();
    run.assertDispatch(prepared);
    const read = await run.approve(
      { id: prepared.call.id, tool: "read_file", input: { path, limit: 1 } },
      signal,
    );
    if (typeof read === "string" || !read.result.path || read.result.category === "read_ai_config")
      throw new OfficeError("office_invalid");
    await run.assertDerivedRead(read, signal);
    const result = await run.target.readBinary({
      cwd: read.cwd,
      writeRoots: run.writeRoots(read),
      rootIdentities: read.boundary?.roots,
      denyWriteRoots: read.boundary?.denyWriteRoots,
      expectedPath: read.result.path.path,
      path: read.result.path.path,
      signal,
    });
    signal.throwIfAborted();
    await run.assertDerivedRead(read, signal);
    run.assertDispatch(prepared);
    if (
      template?.path === path &&
      template.expectedRevision &&
      template.expectedRevision !== result.revision
    )
      throw new OfficeError("office_changed");
    if (imagePaths.has(path)) {
      total += result.bytes.byteLength;
      if (result.bytes.byteLength > 5 * 1024 * 1024 || total > 10 * 1024 * 1024)
        throw new OfficeError("office_invalid");
    }
    images[path] = result.bytes;
    run.local.approvals.audit.append({
      botId: run.context.botId,
      runId: run.context.runId,
      kind: "file.read",
      summary: "Read Office source asset / 读取文档源资源",
      detail: { path: read.result.path.path, toolCallId: prepared.call.id, toolName: "read_file" },
    });
  }
  return images;
}
