import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import { useEffect, useRef } from "react";
import type { ViewerProps } from "./engine.ts";
import styles from "./preview.module.css";

function language(name: string) {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  return (
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        mjs: "javascript",
        json: "javascript",
        css: "css",
        html: "html",
        htm: "html",
        py: "python",
        sh: "shell",
        sql: "sql",
        yml: "yaml",
        yaml: "yaml",
        xml: "xml",
      } as Record<string, string>
    )[extension] ?? "plaintext"
  );
}
export default function CodeViewer(props: ViewerProps) {
  const host = useRef<HTMLElement>(null),
    editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined),
    latest = useRef(props);
  latest.current = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: model lifetime belongs to the immutable file revision
  useEffect(() => {
    if (!host.current) return;
    // Monaco's worker factory is an external library adapter; it only creates our bundled editor worker.
    const previousEnvironment = self.MonacoEnvironment;
    const workers = new Set<Worker>();
    const environment = {
      getWorker: () => {
        const worker = new EditorWorker();
        workers.add(worker);
        return worker;
      },
    };
    self.MonacoEnvironment = environment;
    const model = monaco.editor.createModel(props.result.text ?? "", language(props.file.name));
    const instance = monaco.editor.create(host.current, {
      model,
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13 * props.file.reading.zoom,
      scrollBeyondLastLine: false,
      wordWrap: "off",
      links: false,
      contextmenu: false,
      renderValidationDecorations: "off",
      unicodeHighlight: { ambiguousCharacters: false, nonBasicASCII: false },
      padding: { top: 12 },
    });
    editor.current = instance;
    latest.current.ready?.();
    const applyTheme = () => {
      const css = getComputedStyle(document.documentElement),
        tokenValue = (name: string) => css.getPropertyValue(name).trim();
      monaco.editor.defineTheme("pibot-file", {
        base: document.documentElement.dataset.theme === "dark" ? "vs-dark" : "vs",
        inherit: true,
        rules: [],
        colors: {
          "editor.background": tokenValue("--bg"),
          "editor.foreground": tokenValue("--text"),
          "editorLineNumber.foreground": tokenValue("--text2"),
        },
      });
      monaco.editor.setTheme("pibot-file");
    };
    applyTheme();
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    instance.setScrollPosition({
      scrollTop: props.file.reading.y,
      scrollLeft: props.file.reading.x,
    });
    const off = instance.onDidScrollChange((event) =>
      latest.current.update(props.file.key, { x: event.scrollLeft, y: event.scrollTop }),
    );
    return () => {
      observer.disconnect();
      off.dispose();
      instance.dispose();
      for (const worker of workers) worker.terminate();
      if (self.MonacoEnvironment === environment) self.MonacoEnvironment = previousEnvironment;
      model.dispose();
      editor.current = undefined;
    };
  }, [props.result.revision, props.result.text, props.file.key]);
  useEffect(
    () => editor.current?.updateOptions({ fontSize: 13 * props.file.reading.zoom }),
    [props.file.reading.zoom],
  );
  return <section ref={host} className={styles.codeHost} aria-label={props.file.name} />;
}
