import { HostMethods } from "@pibot/protocol";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { z } from "zod";

declare global {
  interface Window {
    attachmentConverter: { request(): Promise<unknown>; finish(result: unknown): void };
  }
}
const jobSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("image"),
    params: HostMethods["host.attachments.image"].params,
  }),
  z.strictObject({ kind: z.literal("pdf"), params: HostMethods["host.attachments.pdf"].params }),
]);
GlobalWorkerOptions.workerSrc = workerUrl;

function bytes(data: string) {
  const raw = atob(data);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
function canvas(width: number, height: number) {
  const result = document.createElement("canvas");
  result.width = Math.max(1, Math.round(width));
  result.height = Math.max(1, Math.round(height));
  return result;
}
function png(surface: HTMLCanvasElement) {
  return {
    type: "image" as const,
    mimeType: "image/png" as const,
    data: surface.toDataURL("image/png").split(",")[1],
  };
}
async function render() {
  const job = jobSchema.parse(await window.attachmentConverter.request());
  if (job.kind === "image") {
    const bitmap = await createImageBitmap(
      new Blob([bytes(job.params.data).buffer], { type: job.params.mimeType }),
    );
    try {
      if (bitmap.width * bitmap.height > 40_000_000) throw new Error("Image too large");
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const surface = canvas(bitmap.width * scale, bitmap.height * scale);
      surface.getContext("2d")?.drawImage(bitmap, 0, 0, surface.width, surface.height);
      return { image: png(surface), width: surface.width, height: surface.height };
    } finally {
      bitmap.close();
    }
  }
  const task = getDocument({
    data: bytes(job.params.data),
    cMapUrl: new URL("assets/cmaps/", window.location.href).href,
    standardFontDataUrl: new URL("assets/standard_fonts/", window.location.href).href,
    wasmUrl: new URL("assets/wasm/", window.location.href).href,
    useWorkerFetch: true,
    useWasm: false,
    verbosity: 0,
    maxImageSize: 40_000_000,
    canvasMaxAreaInBytes: 40_000_000,
    stopAtErrors: true,
  });
  task.onPassword = () => {
    void task.destroy();
  };
  try {
    const pdf = await task.promise;
    const images = [];
    for (let page = 1; page <= Math.min(pdf.numPages, job.params.pages); page++) {
      const sheet = await pdf.getPage(page);
      const original = sheet.getViewport({ scale: 1 });
      const viewport = sheet.getViewport({
        scale: Math.min(2, 1600 / Math.max(original.width, original.height)),
      });
      const surface = canvas(viewport.width, viewport.height);
      await sheet.render({ canvas: surface, viewport }).promise;
      images.push(png(surface));
      sheet.cleanup();
      surface.width = surface.height = 0;
    }
    return { images, totalPages: pdf.numPages };
  } finally {
    await task.destroy();
  }
}
void render().then(
  (result) => window.attachmentConverter.finish({ ok: true, result }),
  () => window.attachmentConverter.finish({ ok: false }),
);
