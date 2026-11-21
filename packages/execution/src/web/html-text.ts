// Own module (and package subpath) so the desktop main process can reuse web_fetch's rule for
// the Bot browser snapshot without loading the sandbox, undici or the rest of exec.
// linkedom (~200 modules with its CSS/DOM helpers) loads on the first page read, not with the
// brain: no first-screen request parses HTML.
export async function htmlText(html: string, options: { maxElements?: number } = {}) {
  const [{ Readability }, { parseHTML }] = await Promise.all([
    import("@mozilla/readability"),
    import("linkedom"),
  ]);
  const { document } = parseHTML(html);
  const title = document.querySelector("title")?.textContent?.trim() ?? "";
  for (const node of document.querySelectorAll("script,style,noscript,iframe,nav,header,footer"))
    node.remove();
  const fallback = document.body?.textContent || document.documentElement?.textContent || "";
  // Readability took 1.4–3.5 s of the desktop main thread on a 13k-element article while
  // its result there differed from the plain text by 3%; very large pages use the plain text.
  if (options.maxElements && document.querySelectorAll("*").length > options.maxElements)
    return { title, text: fallback };
  try {
    const article = new Readability(document.cloneNode(true) as unknown as Document).parse();
    return { title: article?.title || title, text: article?.textContent || fallback };
  } catch {
    // Readability rejects some valid HTML layouts; plain extracted text remains useful reference data.
    return { title, text: fallback };
  }
}

const WORKER_TIMEOUT_MS = 15_000;

/** Cheap tag strip for when the worker cannot answer; linear in the input, no DOM. */
function plainText(html: string) {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * htmlText in a worker thread. The Bot browser runs in the desktop background process, whose main
 * thread also answers the brain and the window: parsing a large page there (x.com, 2 MB of HTML)
 * stalled it long enough that the host was reported gone and the run could not drain (owner
 * 2026-11-18). A worker that fails or overruns yields the plain stripped text instead.
 */
export async function htmlTextInWorker(
  html: string,
  options: { maxElements?: number } = {},
): Promise<{ title: string; text: string }> {
  const [{ Worker }, { existsSync }] = await Promise.all([
    import("node:worker_threads"),
    import("node:fs"),
  ]);
  const bundled = new URL("./html-text-worker.js", import.meta.url);
  const source = new URL("./html-text-worker.ts", import.meta.url);
  let worker: import("node:worker_threads").Worker;
  try {
    worker = new Worker(existsSync(bundled) ? bundled : source, {
      workerData: { html, maxElements: options.maxElements },
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 },
      stdout: true,
      stderr: true,
    });
  } catch {
    return { title: "", text: plainText(html) };
  }
  worker.stdout?.resume();
  worker.stderr?.resume();
  try {
    return await new Promise((resolve) => {
      const fallback = () => resolve({ title: "", text: plainText(html) });
      const timer = setTimeout(fallback, WORKER_TIMEOUT_MS);
      worker.once("message", (value: { ok?: boolean; title?: unknown; text?: unknown }) => {
        clearTimeout(timer);
        if (value?.ok && typeof value.text === "string")
          resolve({ title: typeof value.title === "string" ? value.title : "", text: value.text });
        else fallback();
      });
      worker.once("error", () => {
        clearTimeout(timer);
        fallback();
      });
      worker.once("exit", () => {
        clearTimeout(timer);
        fallback();
      });
    });
  } finally {
    await worker.terminate();
  }
}
