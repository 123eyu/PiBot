import type { HostParams, HostResults } from "@pibot/protocol";

type Input = HostParams["host.office.render"] & { edge: number; pixels: number; pageBytes: number };
type Page = HostResults["host.office.render"][number];
type OfficeDocument = {
  count: number;
  bitmap(index: number, edge: number): Promise<ImageBitmap>;
  destroy(): void;
};

const bridge = (
  window as unknown as {
    officePageRenderer: { request(): Promise<Input | null>; finish(pages: Page[] | null): void };
  }
).officePageRenderer;
const asset = (name: Input["format"]) => new URL(`../ooxml/${name}.mjs`, document.baseURI).href;
const options = { mode: "worker", useGoogleFonts: false, workerTimeoutMs: 20_000 } as const;

function fittedWidth(width: number, height: number, edge: number) {
  const ratio = width / height;
  if (!Number.isFinite(ratio) || ratio < 1 / 100 || ratio > 100)
    throw new Error("invalid page size");
  return Math.max(1, Math.floor(Math.min(edge, edge * ratio)));
}

async function open(format: Input["format"], bytes: ArrayBuffer): Promise<OfficeDocument> {
  if (format === "pptx") {
    const { PptxPresentation } = (await import(
      /* @vite-ignore */ asset(format)
    )) as typeof import("@silurus/ooxml/pptx");
    const pptx = await PptxPresentation.load(bytes, options);
    return {
      count: pptx.slideCount,
      bitmap: (index, edge) =>
        pptx.renderSlideToBitmap(index, {
          width: fittedWidth(pptx.slideWidth, pptx.slideHeight, edge),
          dpr: 1,
        }),
      destroy: () => pptx.destroy(),
    };
  }
  if (format === "docx") {
    const { DocxDocument } = (await import(
      /* @vite-ignore */ asset(format)
    )) as typeof import("@silurus/ooxml/docx");
    const docx = await DocxDocument.load(bytes, options);
    try {
      await docx.waitUntilLayoutComplete();
    } catch (error) {
      docx.destroy();
      throw error;
    }
    return {
      count: docx.pageCount,
      bitmap: (index, edge) => {
        const { widthPt, heightPt } = docx.pageSize(index);
        return docx.renderPageToBitmap(index, {
          width: fittedWidth(widthPt, heightPt, edge),
          dpr: 1,
        });
      },
      destroy: () => docx.destroy(),
    };
  }
  const { XlsxWorkbook } = (await import(
    /* @vite-ignore */ asset(format)
  )) as typeof import("@silurus/ooxml/xlsx");
  const xlsx = await XlsxWorkbook.load(bytes, options);
  return {
    count: xlsx.sheetCount,
    bitmap: (index, edge) =>
      xlsx.renderViewportToBitmap(
        index,
        { row: 0, col: 0, rows: 40, cols: 24 },
        {
          width: edge,
          height: Math.floor(edge * 0.73),
          dpr: 1,
        },
      ),
    destroy: () => xlsx.destroy(),
  };
}

function encode(bitmap: ImageBitmap, page: number, edge: number, pageBytes: number): Page {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context || !bitmap.width || !bitmap.height) throw new Error("missing canvas");
  let scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 8; attempt++, scale *= 0.75) {
    canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
    canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
    // Document paper, not app chrome: Office pages are white regardless of the UI theme, and the
    // opaque canvas would otherwise export a black page behind transparent slide areas.
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const prefix = "data:image/png;base64,";
    const url = canvas.toDataURL("image/png");
    if (url.startsWith(prefix) && url.length - prefix.length <= 4 * Math.floor(pageBytes / 3))
      return { page, width: canvas.width, height: canvas.height, data: url.slice(prefix.length) };
  }
  throw new Error("PNG limit");
}

async function render(input: Input) {
  const raw = atob(input.data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const office = await open(input.format, bytes.buffer);
  const results: Page[] = [];
  try {
    const edge = Math.min(input.edge, Math.floor(Math.sqrt(input.pixels / input.pages.length)));
    for (const page of input.pages) {
      if (page > office.count) continue;
      const bitmap = await office.bitmap(page - 1, edge);
      try {
        results.push(encode(bitmap, page, edge, input.pageBytes));
      } finally {
        bitmap.close();
      }
    }
    return results;
  } finally {
    office.destroy();
  }
}

void (async () => {
  try {
    const input = await bridge.request();
    if (input) bridge.finish(await render(input));
  } catch {
    // Untrusted document failures are deliberately mapped to a fixed host error.
    bridge.finish(null);
  }
})();
