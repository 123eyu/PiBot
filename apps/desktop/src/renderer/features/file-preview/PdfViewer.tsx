import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { useEffect, useRef, useState } from "react";
import type { ViewerProps } from "./engine.ts";
import styles from "./preview.module.css";
import { previewBytes } from "./use-preview-file.ts";
export default function PdfViewer(props: ViewerProps) {
  const canvas = useRef<HTMLCanvasElement>(null),
    host = useRef<HTMLDivElement>(null),
    latest = useRef(props),
    [pdf, setPdf] = useState<PDFDocumentProxy>();
  latest.current = props;
  const [width, setWidth] = useState(400);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(100, entries[0]?.contentRect.width ?? 400)),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: immutable file revision owns the loading task
  useEffect(() => {
    GlobalWorkerOptions.workerSrc = workerUrl;
    let closed = false,
      task: PDFDocumentLoadingTask | undefined;
    const timeout = setTimeout(() => {
      void task?.destroy();
      if (!closed) latest.current.fail();
    }, 30_000);
    task = getDocument({
      data: previewBytes(props.result.data),
      cMapUrl: new URL("pdf/assets/cmaps/", document.baseURI).href,
      standardFontDataUrl: new URL("pdf/assets/standard_fonts/", document.baseURI).href,
      wasmUrl: new URL("pdf/assets/wasm/", document.baseURI).href,
      useWorkerFetch: true,
      useWasm: false,
      verbosity: 0,
      maxImageSize: 40_000_000,
      canvasMaxAreaInBytes: 40_000_000,
      stopAtErrors: true,
    });
    task.onPassword = () => {
      void task?.destroy();
      if (!closed) latest.current.fail();
    };
    void task.promise
      .then((value) => {
        clearTimeout(timeout);
        if (!closed) {
          setPdf(value);
          latest.current.metadata({ total: value.numPages });
        }
      })
      .catch(() => {
        clearTimeout(timeout);
        if (!closed) latest.current.fail();
      });
    return () => {
      closed = true;
      clearTimeout(timeout);
      void task?.destroy();
    };
  }, [props.result.data, props.result.revision]);
  const { page, zoom } = props.file.reading;
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let closed = false,
      render: RenderTask | undefined;
    const surface = canvas.current;
    void pdf
      .getPage(Math.min(page + 1, pdf.numPages))
      .then(async (item) => {
        if (closed) return;
        const base = item.getViewport({ scale: 1 }),
          scale = Math.min(3, ((width - 32) / base.width) * zoom),
          viewport = item.getViewport({ scale });
        if (viewport.width * viewport.height > 16_000_000) throw Error("canvas_limit");
        surface.width = Math.ceil(viewport.width);
        surface.height = Math.ceil(viewport.height);
        render = item.render({ canvas: surface, viewport });
        await render.promise;
        if (!closed) {
          host.current?.scrollTo(latest.current.file.reading.x, latest.current.file.reading.y);
          item.cleanup();
          latest.current.ready?.();
        }
      })
      .catch(() => {
        if (!closed) latest.current.fail();
      });
    return () => {
      closed = true;
      render?.cancel();
      surface.width = surface.height = 0;
    };
  }, [pdf, page, zoom, width]);
  return (
    <div
      ref={host}
      className={styles.canvasHost}
      onScroll={(event) =>
        props.update(props.file.key, {
          x: event.currentTarget.scrollLeft,
          y: event.currentTarget.scrollTop,
        })
      }
    >
      <canvas ref={canvas} className={styles.pdfCanvas} aria-label={props.file.name} />
    </div>
  );
}
