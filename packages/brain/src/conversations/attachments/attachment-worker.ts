import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

const request = z.strictObject({
  data: z.instanceof(Uint8Array),
  pdf: z.boolean(),
  maxPages: z.number().int().positive().max(1000).optional(),
});
const CACHE_LIMIT = 1_000_000;

function checkDocxZip(data: Buffer) {
  // Bound inflated DOCX data before Mammoth allocates it; ZIP64/encrypted archives are not
  // supported.
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > data.length) throw new Error("Invalid DOCX");
  const entries = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  let total = 0;
  if (entries > 2000 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6))
    throw new Error("DOCX archive too large");
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Invalid DOCX");
    if (data.readUInt16LE(offset + 8) & 1) throw new Error("Encrypted DOCX");
    total += data.readUInt32LE(offset + 24);
    if (total > 64 * 1024 * 1024) throw new Error("DOCX archive too large");
    offset +=
      46 +
      data.readUInt16LE(offset + 28) +
      data.readUInt16LE(offset + 30) +
      data.readUInt16LE(offset + 32);
  }
}

async function extract() {
  const { data, pdf, maxPages } = request.parse(workerData);
  if (!pdf) {
    const buffer = Buffer.from(data);
    checkDocxZip(buffer);
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return {
      text: result.value.slice(0, CACHE_LIMIT),
      totalChars: result.value.length,
      scanned: false,
      pages: 0,
    };
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assets = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const task = getDocument({
    data,
    cMapUrl: join(assets, "cmaps") + sep,
    standardFontDataUrl: join(assets, "standard_fonts") + sep,
    useWorkerFetch: false,
    useSystemFonts: false,
    useWasm: false,
    verbosity: 0,
  });
  task.onPassword = () => {
    void task.destroy();
  };
  try {
    const document = await task.promise;
    if (document.numPages > 1000 && maxPages === undefined) throw new Error("PDF too many pages");
    const parts: string[] = [];
    let totalChars = 0;
    let retained = 0;
    let visible = 0;
    const pageLimit = Math.min(document.numPages, maxPages ?? document.numPages);
    for (let i = 1; i <= pageLimit; i++) {
      const page = await document.getPage(i);
      // Only inspect the text layer. We never create an annotation/scripting layer or request
      // actions and links, so embedded PDF JavaScript and link targets are not executed/followed.
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : ""))
        .join("");
      totalChars += text.length + 1;
      visible += text.replace(/\s/g, "").length;
      if (retained < CACHE_LIMIT) {
        const part = `${text}\n`.slice(0, CACHE_LIMIT - retained);
        retained += part.length;
        parts.push(part);
      }
      page.cleanup();
    }
    return {
      text: parts.join(""),
      totalChars,
      scanned: visible < Math.max(2, pageLimit),
      pages: document.numPages,
    };
  } finally {
    await task.destroy();
  }
}
void extract().then(
  (result) => parentPort?.postMessage({ ok: true, ...result }),
  () => parentPort?.postMessage({ ok: false }),
);
