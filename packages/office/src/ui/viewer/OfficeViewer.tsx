import { useT } from "@pibot/renderer-kit";
import { StatusDot } from "@pibot/ui";
import type { DocxViewer } from "@silurus/ooxml/docx";
import type { PptxViewer } from "@silurus/ooxml/pptx";
import type { XlsxSheetViewer } from "@silurus/ooxml/xlsx";
import { useEffect, useRef, useState } from "react";
import { previewBytes } from "./bytes.ts";
import type { OfficeViewerProps as ViewerProps } from "./types.ts";
import styles from "./viewer.module.css";

type Viewer = DocxViewer | XlsxSheetViewer | PptxViewer;
function canvasMount(container: HTMLElement, canvas: HTMLCanvasElement | null) {
  let mount: HTMLElement | null = canvas;
  while (mount?.parentElement && mount.parentElement !== container) mount = mount.parentElement;
  return mount?.parentElement === container ? mount : undefined;
}
/** Fixed local modules keep the package's relative workers/WASM intact in dev and packaged builds. */
async function moduleFor(format: string) {
  const name = format === "docx" ? "docx" : format === "xlsx" ? "xlsx" : "pptx";
  return import(/* @vite-ignore */ new URL(`ooxml/${name}.mjs`, document.baseURI).href);
}
export default function OfficeViewer(props: ViewerProps) {
  const t = useT(),
    [loading, setLoading] = useState(true);
  const baseScale = useRef(1);
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    viewer = useRef<Viewer | undefined>(undefined),
    latest = useRef(props);
  latest.current = props;
  const { result, file } = props;
  const ready = useRef(false),
    restoring = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: immutable file revision owns an engine; reading updates use the live ref
  useEffect(() => {
    const element = canvas.current,
      container = host.current;
    if (!element || !container) return;
    let closed = false,
      instance: Viewer | undefined;
    ready.current = false;
    setLoading(true);
    const timeout = setTimeout(() => {
      if (!closed) {
        // A slow worker can resolve after the deadline; it must not resurrect a failed preview.
        closed = true;
        instance?.destroy();
        latest.current.fail();
      }
    }, 45_000);
    const options = {
      useGoogleFonts: false,
      cjkFallback: "sc" as const,
      enableHyperlinks: false,
      workerTimeoutMs: 30_000,
      resourceLimits: {
        maxArchiveEntryBytes: 8 * 1024 * 1024,
        maxTotalInflatedBytes: 64 * 1024 * 1024,
        maxArchiveEntries: 2000,
      },
      xlsxWorksheetLimits: {
        maxRows: 100_000,
        maxCells: 250_000,
        maxOwnedUtf8Bytes: 16 * 1024 * 1024,
        maxJsonBytes: 32 * 1024 * 1024,
      },
      zoomMin: 0.1,
      zoomMax: 2,
      onError: () => {
        if (!closed) latest.current.fail();
      },
    };
    void (async () => {
      const api = await moduleFor(result.kind);
      if (closed) return;
      if (result.kind === "xlsx")
        instance = new api.XlsxSheetViewer(element, {
          ...options,
          onViewportChange: (offset: { x: number; y: number }) => {
            if (
              ready.current &&
              !restoring.current &&
              !closed &&
              viewer.current &&
              "goToSheet" in viewer.current &&
              viewer.current.sheetIndex === latest.current.file.reading.sheet
            )
              latest.current.update(file.key, { x: offset.x, y: offset.y });
          },
        });
      else if (result.kind === "docx")
        instance = new api.DocxViewer(element, { ...options, container, mode: "worker" });
      else instance = new api.PptxViewer(element, { ...options, mode: "worker" });
      viewer.current = instance;
      if (result.kind === "xlsx") {
        const mount = canvasMount(container, element);
        if (mount) {
          mount.style.width = `${container.clientWidth}px`;
          mount.style.height = `${container.clientHeight}px`;
        }
      }
      await instance?.load(previewBytes(result.data).buffer);
      if (closed) return;
      const value = instance as Viewer,
        reading = latest.current.file.reading;
      if ("goToSheet" in value) {
        latest.current.metadata({ total: 0, sheets: value.sheetNames });
        const selected = Math.min(reading.sheet, Math.max(0, value.sheetCount - 1));
        await value.goToSheet(selected);
        value.setScale(reading.zoom);
        await value.setViewportOffset({ x: reading.x, y: reading.y });
        if (selected !== reading.sheet) latest.current.update(file.key, { sheet: selected });
      } else {
        const count = "pageCount" in value ? value.pageCount : value.slideCount;
        const page = Math.min(reading.page, Math.max(0, count - 1));
        latest.current.metadata({ total: count });
        if ("goToPage" in value) await value.goToPage(page);
        else await value.goToSlide(page);
        await value.fitWidth();
        baseScale.current = value.getScale();
        await value.setScale(baseScale.current * reading.zoom);
        if (page !== reading.page) latest.current.update(file.key, { page });
      }
      container.scrollTo(reading.x, reading.y);
      ready.current = true;
      latest.current.ready?.();
      setLoading(false);
      clearTimeout(timeout);
    })().catch(() => {
      if (!closed) {
        clearTimeout(timeout);
        instance?.destroy();
        latest.current.fail();
      }
    });
    return () => {
      closed = true;
      clearTimeout(timeout);
      ready.current = false;
      instance?.destroy();
      viewer.current = undefined;
      element.width = element.height = 0;
    };
  }, [result.revision, result.data, result.kind, file.key]);
  useEffect(() => {
    const value = viewer.current;
    if (!ready.current || !value) return;
    let closed = false;
    restoring.current = true;
    void (async () => {
      if ("goToSheet" in value) {
        if (value.sheetIndex !== file.reading.sheet) await value.goToSheet(file.reading.sheet);
        value.setScale(file.reading.zoom);
        await value.setViewportOffset({
          x: latest.current.file.reading.x,
          y: latest.current.file.reading.y,
        });
      } else {
        if ("goToPage" in value) {
          if (value.currentPage !== file.reading.page) await value.goToPage(file.reading.page);
        } else if (value.slideIndex !== file.reading.page) await value.goToSlide(file.reading.page);
        await value.setScale(baseScale.current * file.reading.zoom);
      }
    })()
      .catch(() => {
        if (!closed) latest.current.fail();
      })
      .finally(() => {
        if (!closed) restoring.current = false;
      });
    return () => {
      closed = true;
    };
  }, [file.reading.page, file.reading.sheet, file.reading.zoom]);
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let closed = false;
    let pending = Promise.resolve();
    const observer = new ResizeObserver(() => {
      const value = viewer.current;
      if (!ready.current || !value) return;
      pending = pending
        .then(async () => {
          if (closed || viewer.current !== value) return;
          if ("goToSheet" in value) {
            const mount = canvasMount(container, canvas.current);
            if (mount) {
              mount.style.width = `${container.clientWidth}px`;
              mount.style.height = `${container.clientHeight}px`;
            }
            await value.relayout();
          } else {
            await value.fitWidth();
            baseScale.current = value.getScale();
            await value.setScale(baseScale.current * latest.current.file.reading.zoom);
          }
        })
        .catch(() => {
          if (!closed) latest.current.fail();
        });
    });
    observer.observe(container);
    return () => {
      closed = true;
      observer.disconnect();
    };
  }, []);
  return (
    <div
      ref={host}
      className={styles.canvasHost}
      data-kind={result.kind}
      onScroll={(event) => {
        if (ready.current && result.kind !== "xlsx")
          props.update(file.key, {
            x: event.currentTarget.scrollLeft,
            y: event.currentTarget.scrollTop,
          });
      }}
    >
      {loading && (
        <p className={`${styles.status} ${styles.loading}`} role="status">
          <span className={styles.loadingPill}>
            <StatusDot state="running" />
            {t("common.loading")}
          </span>
        </p>
      )}
      <canvas ref={canvas} aria-label={file.name} />
    </div>
  );
}
