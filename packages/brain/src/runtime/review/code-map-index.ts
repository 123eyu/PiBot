import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import {
  type CodeMapSymbol,
  codeMapExtractorFingerprint,
  codeMapLanguageForPath,
  createCodeMapService,
} from "@pibot/execution/codemap";
import {
  checkedDirectory,
  MAX_SOURCE_BYTES,
  readSource,
  type SemanticFile,
  type SourceAccess,
  type SourceRefusal,
  semanticHash,
  skippableError,
  walkFiles,
} from "@pibot/execution/semantic";
import {
  type CodeMapEntryRow,
  type CodeMapFileState,
  CodeMapRepo,
  type CodeMapSymbolHit,
  type CodeMapSymbolRow,
} from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import { CodeMapBatches } from "./code-map-batches.ts";
import { forgetUnusedCodeMapPaths } from "./code-map-cleanup.ts";
import { summarizeReasons } from "./code-reasons.ts";
import { reviewSourceAccess } from "./review-source-access.ts";
import { semanticFileCache } from "./semantic-cache.ts";

/** Mirrors the parser's own caps so one run sends exactly what one worker call accepts. */
const MAX_FILES = 512;
const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/**
 * The cache's byte budget has to follow its map. Clearing the texts but keeping the
 * counter would make later reads in the same run believe the budget was already spent.
 */
function clearBorrowedText(access: SourceAccess): void {
  if (!access.cache) return;
  access.cache.files.clear();
  access.cache.bytes = 0;
}

/**
 * The index and the tools name a refusal the same way, so one reason code reads the same
 * in every answer. Only the two causes the model can act on differently keep their own code.
 */
function refusalCode(refusal: SourceRefusal): string {
  return refusal === "file_too_large" || refusal === "not_utf8" ? refusal : "denied_or_unavailable";
}

export interface CodeMapRefresh {
  rootKey: string;
  root: string;
  /** Files the walk still sees and that have a stored hash after this run. */
  files: number;
  /** Files replaced after content or extractor changes; only successful parses count. */
  parsed: number;
  /** Files whose extractor, size and mtime matched: no read, no parse. */
  unchanged: number;
  /** Files whose stat moved but whose hash did not: stat columns updated, nothing reparsed. */
  touched: number;
  removed: number;
  symbols: number;
  reasons: string[];
  durationMs: number;
}

type CodeMapChange = { file: CodeMapFileState; symbols: readonly CodeMapSymbolRow[] };

/** `ok: false` names why the file has no outline instead of looking like an empty one. */
export type CodeFileSymbols =
  | {
      ok: true;
      hash: string;
      text: string;
      symbols: CodeMapSymbol[];
      reasons: string[];
    }
  | { ok: false; refusal: SourceRefusal | "unsupported_language" | "not_parsed" };

/**
 * The project's symbol index. It is derived data: every row can be rebuilt from the files
 * this run was already allowed to read, so it never stores text and never widens an authorization.
 */
export class CodeMapIndex {
  private readonly parser: ReturnType<typeof createCodeMapService>;
  private readonly batches = new CodeMapBatches();
  private readonly repo: CodeMapRepo;
  /** One refresh per root at a time; the parser would reject the second call anyway. */
  private readonly busy = new Set<string>();
  constructor(private readonly local: LocalService) {
    // Field initializers run before parameter properties exist, so the parser waits for `local`.
    this.parser = createCodeMapService({ resourcesDir: local.deps.resourcesDir });
    this.repo = new CodeMapRepo(local.deps.db);
  }

  /** The tool-facing entry point: same read boundary, prompt and revocation as the other readers. */
  async refresh(
    context: ToolRunContext,
    root: string,
    signal: AbortSignal,
  ): Promise<CodeMapRefresh> {
    const current = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const access = await reviewSourceAccess(this.local, context, root, current, {
      // Same run, same root: a second refresh reuses the bytes the first one read.
      cache: semanticFileCache(context, root, "codemap"),
    });
    try {
      return await this.run(access, root, current);
    } finally {
      // Project text belongs to the run, not to the index; the row only keeps names and hashes.
      clearBorrowedText(access);
    }
  }

  /**
   * The index proper, split from `refresh` so it can be driven with an explicit access object
   * (probes, and later any caller that already holds an authorized boundary).
   */
  async run(access: SourceAccess, root: string, signal: AbortSignal): Promise<CodeMapRefresh> {
    const started = performance.now();
    // Re-verifies the canonical path and directory identity; a swapped folder is a new root.
    const identity = await checkedDirectory(root, signal);
    const rootKey = semanticHash(`${identity.info.dev}:${identity.info.ino}:${identity.path}`);
    if (this.busy.has(rootKey)) throw new Error("codemap_busy");
    this.busy.add(rootKey);
    try {
      const fingerprint = await codeMapExtractorFingerprint(this.local.deps.resourcesDir, signal);
      const rebuild = this.repo.extractorFingerprint(rootKey) !== fingerprint;
      const stored = this.repo.files(rootKey);
      const reasons = new Set<string>();
      const candidates: { path: string; name: string }[] = [];
      const walked = await walkFiles(
        identity,
        { cwd: identity.path, writeRoots: [], signal, authorizePath: access.authorize },
        async (path, name) => {
          // Language decides what is worth indexing; the walk already skipped caches and builds.
          if (!codeMapLanguageForPath(name)) return;
          // A file is authorized when it is actually read (`readSource` checks it and its
          // ancestors); checking every candidate here ran the policy for up to 20,000 unchanged
          // files per refresh. Rows hold names and ranges only, and navigation re-authorizes every
          // path it
          // returns, so a row that outlived a denial still cannot hand out text.
          candidates.push({ path, name });
        },
      );
      if (walked.truncated) reasons.add(walked.truncated);
      if (walked.skippedUnreadable) reasons.add("denied_or_unavailable");
      const cppDirectories = new Set(
        candidates
          .filter(({ name }) => extname(name).toLowerCase() === ".cpp")
          .map(({ name }) => dirname(name)),
      );

      const keep: string[] = [];
      /** Re-extracted only for a new extractor; kept by the first write, so never "restored". */
      const pending = new Set<string>();
      const touched: { path: string; size: number; mtimeNs: string; hasCppSibling: boolean }[] = [];
      const changed: CodeMapFileState[] = [];
      const texts = new Map<string, string>();
      let bytes = 0;
      let unchanged = 0;
      let reads = 0;
      // Once a cap stops the reads, the rest of the walk still runs so untouched files keep their
      // rows; files that needed a read keep the stale row and get their turn next run.
      let stopped = false;
      for (const { path, name } of candidates) {
        signal.throwIfAborted();
        const info = await this.stat(path, name, reasons);
        if (!info) continue;
        // Symlinks and special files are never indexed, matching what readSource would open.
        if (!info.isFile()) continue;
        const size = Number(info.size);
        const mtimeNs = info.mtimeNs.toString();
        const before = stored.get(name);
        const reextract = rebuild || before?.extractorFingerprint !== fingerprint;
        const hasCppSibling =
          extname(name).toLowerCase() === ".h" && cppDirectories.has(dirname(name));
        // The cheap path: same byte count and same nanosecond mtime. A hash would need a read, and
        // a filesystem that lies about both is out of scope for a derived cache.
        // A header's grammar can change when a sibling is added or removed, without its stat moving.
        if (
          !reextract &&
          before &&
          before.size === size &&
          before.mtimeNs === mtimeNs &&
          (before.hasCppSibling ?? false) === hasCppSibling
        ) {
          keep.push(name);
          unchanged++;
          continue;
        }
        if (stopped) {
          if (before) keep.push(name);
          continue;
        }
        // Only files that must be read count against the caps: unchanged files never take a slot,
        // so a repository larger than one batch still advances instead of re-reading the same head.
        if (reads >= MAX_FILES) {
          stopped = true;
          // Navigation reports this as a partial index; further refreshes fill in the rest.
          reasons.add("results");
          if (before) keep.push(name);
          continue;
        }
        if (bytes + size > MAX_BYTES) {
          stopped = true;
          reasons.add("byte_limit");
          if (before) keep.push(name);
          continue;
        }
        // The reader refuses anything above its own cap, so check the size first: it costs no read
        // and it lets the reason say `file_too_large` instead of blaming permissions.
        if (size > MAX_SOURCE_BYTES) {
          reasons.add(`file_too_large:${name}`);
          continue;
        }
        reads++;
        const read = await this.read(access, path);
        if ("refusal" in read) {
          // Denied, binary or gone: drop any older rows and keep the one reason that fits.
          reasons.add(`${refusalCode(read.refusal)}:${name}`);
          continue;
        }
        const file = read.file;
        bytes += size;
        const language =
          codeMapLanguageForPath(name, {
            text: file.text,
            hasCppSibling,
          }) ?? null;
        if (!reextract && before && before.hash === file.hash && before.language === language) {
          // Touched but identical (checkout, chmod): refresh the stat so the next run is cheap.
          keep.push(name);
          touched.push({ path: name, size, mtimeNs, hasCppSibling });
          continue;
        }
        changed.push({
          path: name,
          language,
          size,
          mtimeNs,
          hash: file.hash,
          extractorFingerprint: fingerprint,
          hasCppSibling,
        });
        texts.set(name, file.text);
        // Same bytes and grammar, older extractor: the stored hash + symbols are still a coherent
        // version of this file, so they stay visible until a checkpoint replaces them.
        // Changed content or grammar is dropped below instead, so an old hash never looks current.
        if (before && before.hash === file.hash && before.language === language) {
          keep.push(name);
          pending.add(name);
        }
      }

      const rootRow = {
        key: rootKey,
        path: identity.path,
        device: identity.info.dev.toString(),
        inode: identity.info.ino.toString(),
        // The target extractor; each file row only advances when its own checkpoint succeeds.
        extractorFingerprint: fingerprint,
      };
      const assertWritable = async () => {
        signal.throwIfAborted();
        access.assertCurrent(signal);
        await checkedDirectory(identity.path, signal, identity.info);
        access.assertCurrent(signal);
      };
      // The walk is complete before pruning. Drop changed versions now, so a parser timeout never
      // leaves an old hash looking current; successful versions are saved in separate checkpoints.
      await assertWritable();
      const written = this.repo.write({
        root: rootRow,
        indexedAt: new Date().toISOString(),
        changed: [],
        touched,
        keep,
      });
      // The first commit records the new target, so later bounded refreshes do not log it again.
      if (rebuild && stored.size > 0)
        this.local.deps.logger.info(
          JSON.stringify({
            event: "codemap.extractor_rebuild",
            root_key: rootKey,
            files: stored.size,
          }),
        );
      let parsedFiles = 0;
      let symbolsWritten = 0;
      let restoredFiles = 0;
      for await (const batch of this.batches.extract(
        (files, current) => this.parser.extract(files, current),
        changed,
        texts,
        signal,
      )) {
        if ("reason" in batch) {
          reasons.add(batch.reason);
          continue;
        }
        const { files: part, result } = batch;
        for (const reason of result.reasons) reasons.add(reason);
        // Only reported files carry symbols; a missing entry means the parser never got to it.
        const parsed = new Map(
          result.files.flatMap((file) =>
            file.symbols ? [[file.path, file.symbols] as const] : [],
          ),
        );
        const writes: CodeMapChange[] = [];
        for (const file of part) {
          const symbols = parsed.get(file.path);
          if (!symbols) {
            // Not parsed (a missing grammar, a parse failure or the symbol cap): changed content
            // already lost its older rows; an extractor-only rebuild keeps its prior coherent
            // version. Neither records this unparsed version as complete, so it is retried.
            reasons.add(`not_parsed:${file.path}`);
            continue;
          }
          writes.push({ file, symbols });
        }
        await assertWritable();
        // No keep set: this checkpoint replaces only fully parsed files, preserving earlier
        // checkpoints and files still waiting. Cancellation never writes an incomplete version.
        const checkpoint = this.repo.write({
          root: rootRow,
          indexedAt: new Date().toISOString(),
          changed: writes,
          touched: [],
        });
        parsedFiles += writes.length;
        symbolsWritten += checkpoint.symbols;
        restoredFiles += writes.filter(
          ({ file }) => stored.has(file.path) && !pending.has(file.path),
        ).length;
      }
      return {
        rootKey,
        root: identity.path,
        files: this.repo.counts(rootKey).files,
        parsed: parsedFiles,
        unchanged,
        touched: touched.length,
        // Replacing a changed version is not a removed file in the refresh summary.
        removed: written.removed - restoredFiles,
        symbols: symbolsWritten,
        reasons: summarizeReasons(reasons),
        durationMs: Math.round(performance.now() - started),
      };
    } finally {
      this.busy.delete(rootKey);
    }
  }

  /**
   * A file that vanished between the walk and the stat (a build, a checkout, a rename)
   * costs its own row, not the whole refresh; the next refresh picks up what the walk sees then.
   */
  private async stat(path: string, name: string, reasons: Set<string>) {
    try {
      return await lstat(path, { bigint: true });
    } catch (error) {
      if (!skippableError(error)) throw error;
      reasons.add(`denied_or_unavailable:${name}`);
      return undefined as BigIntStats | undefined;
    }
  }

  /**
   * Same for a read: only a file-level filesystem race is skipped, everything else is a bug. The
   * refusal cause travels with the result so the index can say why a file has no rows.
   */
  private async read(
    access: SourceAccess,
    path: string,
  ): Promise<{ file: SemanticFile } | { refusal: SourceRefusal }> {
    let refusal: SourceRefusal = "denied";
    try {
      const file = await readSource(access, path, (reason) => {
        refusal = reason;
      });
      return file ? { file } : { refusal };
    } catch (error) {
      if (!skippableError(error)) throw error;
      return { refusal };
    }
  }

  /** The path bound to a working-folder record, read before that record is hidden or deleted. */
  folderPath(folderId: string): string | undefined {
    return this.local.workplaces.repo.path(folderId);
  }

  /**
   * One name's definitions and uses from the stored index. Rows are re-authorized by the
   * caller before they reach the model, because the index outlives the consent that built it.
   */
  search(
    rootKey: string,
    name: string,
    options: { prefix?: string; limit: number },
  ): CodeMapSymbolHit[] {
    return this.repo.search(rootKey, name, options);
  }

  /** Definitions ranked by how often their name is referenced, for `code_map`. */
  entries(rootKey: string, options: { prefix?: string; limit: number }): CodeMapEntryRow[] {
    return this.repo.entries(rootKey, options);
  }

  /** Stored totals, not this run's writes, so `indexed` describes the whole index. */
  counts(rootKey: string): { files: number; symbols: number } {
    return this.repo.counts(rootKey);
  }

  /**
   * The syntax-level outline of one file. It reads through the same per-path authorization
   * as the index, so an outline cannot reach a file the index would have refused.
   */
  async fileSymbols(
    context: ToolRunContext,
    root: string,
    path: string,
    signal: AbortSignal,
  ): Promise<CodeFileSymbols> {
    const language = codeMapLanguageForPath(path);
    if (!language) return { ok: false, refusal: "unsupported_language" };
    const access = await reviewSourceAccess(this.local, context, root, signal, {
      cache: semanticFileCache(context, root, "codemap"),
    });
    try {
      let refusal: SourceRefusal = "denied";
      const file = await readSource(access, resolve(root, path), (reason) => {
        refusal = reason;
      });
      if (!file) return { ok: false, refusal };
      const result = await this.parser.extract(
        [
          {
            path,
            text: file.text,
            hasCppSibling:
              extname(path).toLowerCase() === ".h" &&
              (await this.hasCppSibling(access, resolve(root, path))),
          },
        ],
        signal,
      );
      const symbols = result.files[0]?.symbols;
      // The parser leaves a file out when its grammar is missing or its parse failed; an empty
      // outline would claim the file has no declarations, so this is reported as its own cause.
      if (!symbols) return { ok: false, refusal: "not_parsed" };
      // Parsing may outlive consent or a file version. Re-read through the same bound access
      // (usually a metadata-verified cache hit) before returning ranges and previews.
      const current = await readSource(access, resolve(root, path), (reason) => {
        refusal = reason;
      });
      if (!current) return { ok: false, refusal };
      if (current.hash !== file.hash) return { ok: false, refusal: "changed" };
      return {
        ok: true,
        hash: file.hash,
        // The caller builds previews from the same bytes it parsed; the index itself stores none.
        text: file.text,
        symbols,
        reasons: result.reasons,
      };
    } finally {
      // Only ranges leave this method; the text was borrowed for the parse, like the index run.
      clearBorrowedText(access);
    }
  }

  /** Use the existing authorized walker, restricted to one directory; never inspect siblings in a worker. */
  private async hasCppSibling(access: SourceAccess, path: string): Promise<boolean> {
    const directory = await checkedDirectory(dirname(path), access.signal);
    let found = false;
    await walkFiles(
      directory,
      {
        cwd: access.root,
        writeRoots: [],
        signal: access.signal,
        authorizePath: access.authorize,
      },
      (_path, name) => {
        if (extname(name).toLowerCase() !== ".cpp") return;
        found = true;
        return "results";
      },
      () => false,
    );
    return found;
  }

  /**
   * Drops the index of every path that no visible record still shows. Hidden records
   * are kept on purpose (topics and routines still use them), and failures only log: the index
   * rebuilds on next use.
   */
  forgetPaths(paths: readonly string[]): number {
    return forgetUnusedCodeMapPaths(
      { codeMap: this.repo, workplaces: this.local.workplaces.repo },
      this.local.deps.logger,
      paths,
    );
  }

  async dispose() {
    await this.parser.dispose();
  }
}
