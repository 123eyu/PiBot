import { posix } from "node:path";
import ts from "typescript-runtime";
import type { SemanticQuery, SemanticSnapshot } from "./types.ts";

/** Virtual names contain no user absolute paths; every Host read is Map-only. */
export function querySemantic(
  snapshot: SemanticSnapshot,
  query: SemanticQuery,
  libraries: [string, string][],
  cancelled: Int32Array,
) {
  const root = "/project",
    libraryRoot = "/stdlib";
  const files = new Map(snapshot.files.map((f) => [posix.join(root, f.path), f.text]));
  const libraryFiles = new Map(
    libraries.map(([name, text]) => [posix.join(libraryRoot, name), text]),
  );
  const all = new Map([...files, ...libraryFiles]);
  const reasons = new Set(snapshot.reasons);
  const read = (path: string) => {
    const value = all.get(posix.normalize(path));
    if (value === undefined) reasons.add("unresolved_project_or_dependency");
    return value;
  };
  const hostRead: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    fileExists: (path) => all.has(posix.normalize(path)),
    readFile: read,
    readDirectory: (directory, extensions, _exclude, _include, depth) =>
      [...files.keys()].filter(
        (p) =>
          p.startsWith(`${directory}/`) &&
          (!extensions || extensions.some((e) => p.endsWith(e))) &&
          (depth === undefined || p.slice(directory.length + 1).split("/").length <= depth + 1),
      ),
  };
  // A project-wide symbol search has no file to anchor on, so config discovery starts at the root.
  const target = query.path ? posix.join(root, query.path) : undefined;
  let directory = target ? posix.dirname(target) : root,
    config: string | null = null;
  if (query.configPath) {
    const selected = posix.join(root, query.configPath);
    if (!files.has(selected)) throw new Error("semantic_config_unavailable");
    config = selected;
  }
  while (!config && directory.startsWith(root)) {
    config =
      ["tsconfig.json", "jsconfig.json"]
        .map((name) => posix.join(directory, name))
        .find((p) => files.has(p)) ?? null;
    if (config || directory === root) break;
    directory = posix.dirname(directory);
  }
  let options: ts.CompilerOptions = {
    allowJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  let roots = [...files.keys()].filter((name) => /\.[cm]?[jt]sx?$/.test(name));
  let configErrors: readonly ts.Diagnostic[] = [];
  if (config) {
    const parsed = ts.parseConfigFileTextToJson(config, files.get(config) ?? "");
    if (parsed.error) configErrors = [parsed.error];
    else {
      const result = ts.parseJsonConfigFileContent(
        parsed.config,
        hostRead,
        posix.dirname(config),
        { noEmit: true },
        config,
      );
      options = {
        ...result.options,
        noEmit: true,
        plugins: [],
        disableSourceOfProjectReferenceRedirect: true,
      };
      roots = result.fileNames;
      configErrors = result.errors;
      if (parsed.config.compilerOptions?.plugins?.length) reasons.add("plugins_ignored");
      if (result.projectReferences?.length) reasons.add("project_references_not_loaded");
    }
  }
  // A solution-style config lists only its own entry files, so a project-wide symbol search would
  // otherwise see almost nothing; the snapshot is already the bound, so search all of its sources.
  if (query.operation === "symbol" && !target) {
    roots = [...files.keys()].filter((name) => /\.[cm]?[jt]sx?$/.test(name));
  }
  if (target && !roots.includes(target)) {
    roots.push(target);
    reasons.add("file_outside_config");
  }
  if (query.fileOnly && target) roots = [target];
  const host: ts.LanguageServiceHost = {
    ...hostRead,
    readDirectory: (path, extensions, exclude, include, depth) => [
      ...hostRead.readDirectory(path, extensions ?? [], exclude ?? [], include ?? [], depth),
    ],
    getCompilationSettings: () => options,
    getScriptFileNames: () => roots,
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => {
      const text = read(name);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: () => posix.join(libraryRoot, ts.getDefaultLibFileName(options)),
    getCancellationToken: () => ({
      isCancellationRequested: () => Atomics.load(cancelled, 0) !== 0,
    }),
    directoryExists: (name) => [...all.keys()].some((p) => p.startsWith(`${name}/`)),
    getDirectories: (name) => [
      ...new Set(
        [...all.keys()]
          .filter((p) => p.startsWith(`${name}/`))
          .map((p) => p.slice(name.length + 1).split("/")[0] ?? "")
          .filter(Boolean),
      ),
    ],
    realpath: (name) => posix.normalize(name),
    useCaseSensitiveFileNames: () => true,
  };
  const service = ts.createLanguageService(host);
  const locations: {
    path: string;
    range: { line: number; column: number; endLine: number; endColumn: number };
    preview: string;
  }[] = [];
  const diagnostics: {
    path: string | null;
    range: { line: number; column: number; endLine: number; endColumn: number } | null;
    code: number;
    category: "warning" | "error" | "suggestion" | "message";
    message: string;
  }[] = [];
  const symbols: {
    path: string;
    name: string;
    kind: string;
    range: { line: number; column: number; endLine: number; endColumn: number };
    preview: string;
    containerName: string | null;
  }[] = [];
  const outline: {
    name: string;
    kind: string;
    depth: number;
    range: { line: number; column: number; endLine: number; endColumn: number };
    preview: string;
  }[] = [];
  const limit = query.limit ?? 200;
  let truncated = false;
  let outputBytes = 0;
  const fits = (value: unknown) => {
    const size = Buffer.byteLength(JSON.stringify(value));
    if (outputBytes + size > 120 * 1024) {
      truncated = true;
      return false;
    }
    outputBytes += size;
    return true;
  };
  // Generated code can carry identifiers longer than the result schema allows; clipping here keeps
  // one long name from failing the whole result parse on the brain side.
  const clip = (value: string, max: number) =>
    value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
  const range = (source: ts.SourceFile, start: number, length: number) => {
    const a = source.getLineAndCharacterOfPosition(start),
      b = source.getLineAndCharacterOfPosition(start + length);
    return {
      line: a.line + 1,
      column: a.character + 1,
      endLine: b.line + 1,
      endColumn: b.character + 1,
    };
  };
  const programSource = (fileName: string) =>
    files.has(fileName) ? service.getProgram()?.getSourceFile(fileName) : undefined;
  const explicitPosition = (source: ts.SourceFile) => {
    const line = (query.line ?? 1) - 1,
      column = (query.column ?? 1) - 1;
    const starts = source.getLineStarts();
    if (
      line >= starts.length ||
      column > (starts[line + 1] ?? source.text.length) - (starts[line] ?? 0)
    )
      throw new Error("semantic_position_invalid");
    return source.getPositionOfLineAndCharacter(line, column);
  };
  // One declaration shape everywhere: search hits, call-hierarchy neighbours and ambiguous-name
  // candidates, so a candidate can be fed back to the tool unchanged.
  const declarationItem = (
    fileName: string,
    name: string,
    kind: string,
    span: ts.TextSpan,
    containerName?: string,
  ) => {
    const file = programSource(fileName);
    if (!file) {
      reasons.add("external_location_omitted");
      return;
    }
    return {
      path: posix.relative(root, fileName),
      name: clip(name, 200),
      // TypeScript reports an empty kind for some JS constructs; the wire schema needs one.
      kind: clip(kind, 40) || "unknown",
      range: range(file, span.start, span.length),
      preview: file.text.slice(span.start, span.start + 240),
      containerName: containerName ? clip(containerName, 200) : null,
    };
  };
  const addSymbol = (item: NonNullable<ReturnType<typeof declarationItem>>) => {
    if (symbols.length >= limit) {
      truncated = true;
      return false;
    }
    if (!fits(item)) return false;
    symbols.push(item);
    return true;
  };
  // Overload signatures and merged declarations share name, kind and container: one target, not
  // ambiguity; a different container or kind is a genuinely different declaration.
  const identity = (entry: { name: string; kind: string; containerName?: string }) =>
    `${entry.name}\u0000${entry.kind}\u0000${entry.containerName ?? ""}`;
  const candidatesFor = (search: string, fileName: string): ts.NavigateToItem[] => {
    const lastDot = search.lastIndexOf("."),
      qualifier = lastDot > 0 ? search.slice(0, lastDot) : undefined,
      name = qualifier ? search.slice(lastDot + 1) : search;
    const entries = service.getNavigateToItems(name, 500, fileName, false, true) ?? [];
    // Navigate-to also matches prefixes and substrings, and a qualifier must match the container so
    // that `A.run` never silently resolves to `B.run`.
    return entries.filter(
      (entry) =>
        entry.name === name &&
        (qualifier === undefined ||
          entry.containerName === qualifier ||
          (entry.containerName?.endsWith(`.${qualifier}`) ?? false)),
    );
  };
  /** A name stands in for a position only when it denotes exactly one declaration. */
  const resolveByName = (fileName: string, search: string): number | undefined => {
    const distinct = [
      ...new Map(candidatesFor(search, fileName).map((e) => [identity(e), e])).values(),
    ];
    const [only] = distinct;
    if (!only) {
      reasons.add("symbol_not_found");
      return;
    }
    if (distinct.length > 1) {
      reasons.add("ambiguous_symbol");
      for (const entry of distinct) {
        const item = declarationItem(
          fileName,
          entry.name,
          entry.kind,
          entry.textSpan,
          entry.containerName,
        );
        if (item && !addSymbol(item)) break;
      }
      return;
    }
    // Call-hierarchy resolution reads the token at the position, so aim at the declared name rather
    // than the `function` / `const` keyword in front of it.
    const source = programSource(fileName),
      span = only.textSpan,
      offset = source?.text.slice(span.start, span.start + span.length).indexOf(only.name) ?? -1;
    return offset > 0 ? span.start + offset : span.start;
  };
  try {
    if (query.operation !== "symbol" && !target) throw new Error("semantic_file_unavailable");
    if (target !== undefined && !files.has(target)) throw new Error("semantic_file_unavailable");
    if (query.operation === "symbol") {
      const search = query.query ?? "";
      // The compiler already orders exact matches before prefix/substring ones, so a capped scan
      // keeps the best hits; we only drop results from files outside the snapshot.
      const entries = service.getNavigateToItems(
        search,
        Math.min(limit * 4, 500),
        target,
        false,
        true,
      );
      for (const entry of entries) {
        const item = declarationItem(
          entry.fileName,
          entry.name,
          entry.kind,
          entry.textSpan,
          entry.containerName,
        );
        if (item && !addSymbol(item)) break;
      }
    } else if (query.operation === "outline") {
      if (!target) throw new Error("semantic_file_unavailable");
      const source = service.getProgram()?.getSourceFile(target);
      if (!source) throw new Error("semantic_file_unavailable");
      // Returns whether the walk must stop, so a full list does not keep recursing through siblings.
      const walk = (node: ts.NavigationTree, depth: number): boolean => {
        for (const child of node.childItems ?? []) {
          if (outline.length >= limit) {
            truncated = true;
            return true;
          }
          // Merged declarations share one node, and placeholder nodes carry no span to locate.
          const span = child.spans[0] ?? child.nameSpan;
          if (!span || !child.text) continue;
          const item = {
            name: clip(child.text, 200),
            // Same as above: an empty kind (e.g. `Object.defineProperty(x, 'y', …)`) is not a crash.
            kind: clip(child.kind, 40) || "unknown",
            depth,
            range: range(source, span.start, span.length),
            preview: source.text.slice(span.start, span.start + 240),
          };
          if (!fits(item)) return true;
          outline.push(item);
          if (walk(child, depth + 1)) return true;
        }
        return false;
      };
      walk(service.getNavigationTree(target), 0);
    } else if (query.operation === "diagnostics") {
      if (!target) throw new Error("semantic_file_unavailable");
      const configuration = [...configErrors, ...service.getCompilerOptionsDiagnostics()];
      if (query.fileOnly && configuration.length) reasons.add("configuration_diagnostics_omitted");
      for (const diagnostic of [
        ...(query.fileOnly ? [] : configuration),
        ...service.getSyntacticDiagnostics(target),
        ...service.getSemanticDiagnostics(target),
      ]) {
        if (query.fileOnly && diagnostic.file?.fileName !== target) continue;
        if (diagnostics.length >= limit) {
          truncated = true;
          break;
        }
        if (diagnostic.file && !files.has(diagnostic.file.fileName)) {
          reasons.add("external_diagnostic_omitted");
          continue;
        }
        const item = {
          path: diagnostic.file ? posix.relative(root, diagnostic.file.fileName) : null,
          range:
            diagnostic.file && diagnostic.start !== undefined
              ? range(diagnostic.file, diagnostic.start, diagnostic.length ?? 0)
              : null,
          code: diagnostic.code,
          category:
            (["warning", "error", "suggestion", "message"] as const)[diagnostic.category] ??
            "message",
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n").slice(0, 2000),
        };
        if (!fits(item)) break;
        diagnostics.push(item);
      }
    } else {
      if (!target) throw new Error("semantic_file_unavailable");
      const source = service.getProgram()?.getSourceFile(target);
      if (!source) throw new Error("semantic_file_unavailable");
      const position = query.query
        ? // A name that resolves to nothing (or to several declarations) is reported in `reasons`;
          // the caller re-runs it with a position taken from the candidates.
          resolveByName(target, query.query)
        : explicitPosition(source);
      if (position !== undefined) {
        if (query.operation === "callers" || query.operation === "callees") {
          const calls =
            query.operation === "callers"
              ? service.provideCallHierarchyIncomingCalls(target, position)
              : service.provideCallHierarchyOutgoingCalls(target, position);
          const seen = new Set<string>();
          for (const call of calls) {
            const related = "from" in call ? call.from : call.to;
            // Several call sites inside one function still mean one caller / callee node.
            const key = `${related.file}:${related.span.start}:${related.span.length}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const item = declarationItem(
              related.file,
              related.name,
              related.kind,
              related.span,
              related.containerName,
            );
            if (item && !addSymbol(item)) break;
          }
        } else {
          const entries =
            query.operation === "implementations"
              ? (service.getImplementationAtPosition(target, position) ?? [])
              : query.operation === "definition"
                ? (service.getDefinitionAtPosition(target, position) ?? [])
                : (service.findReferences(target, position) ?? []).flatMap((s) => s.references);
          for (const entry of entries) {
            if (locations.length >= limit) {
              truncated = true;
              break;
            }
            const file = service.getProgram()?.getSourceFile(entry.fileName);
            if (!file || !files.has(entry.fileName)) {
              reasons.add("external_location_omitted");
              continue;
            }
            const item = {
              path: posix.relative(root, entry.fileName),
              range: range(file, entry.textSpan.start, entry.textSpan.length),
              preview: file.text.slice(entry.textSpan.start, entry.textSpan.start + 240),
            };
            if (!fits(item)) break;
            locations.push(item);
          }
        }
      }
    }
    return {
      engine: "typescript" as const,
      engineVersion: "6.0.3" as const,
      operation: query.operation,
      snapshotHash: snapshot.hash,
      config: config ? posix.relative(root, config) : null,
      // A name that is missing or ambiguous is an answer, not missing snapshot coverage.
      partial: [...reasons].some(
        (reason) => reason !== "ambiguous_symbol" && reason !== "symbol_not_found",
      ),
      reasons: [...reasons].slice(0, 30),
      locations,
      diagnostics,
      ...(symbols.length ? { symbols } : {}),
      ...(query.operation === "outline" ? { outline } : {}),
      truncated,
    };
  } finally {
    service.dispose();
  }
}
