import { createHash } from "node:crypto";
import pathApi from "node:path";
import type { DeliverySources } from "./delivery-citations.ts";
import { deliveryFile } from "./delivery-path.ts";

export function sourceDigest(value: string) {
  const url = new URL(value);
  url.hash = "";
  return createHash("sha256").update(url.href).digest("hex");
}

/** Spaces and parentheses can belong to a filename; only a matching observed source disambiguates. */
function pathCandidates(value: string) {
  const line = value.trim();
  const prefixes = [line];
  for (const match of line.matchAll(/ — | - |（|\(|：|\r?\n/g))
    prefixes.push(line.slice(0, match.index).trimEnd());
  // Retain the old path-plus-plain-description form without splitting spaces inside filenames.
  for (const match of line.matchAll(/\.[A-Za-z0-9]{1,10}(?=\s)/g))
    prefixes.push(line.slice(0, match.index + match[0].length));
  // Backtick and link targets are what repair feedback tells the model to write, so they keep
  // their slots ahead of the bare prefixes, which are tried longest first.
  const explicit = [...line.matchAll(/`([^`]+)`|\]\(([^)]+)\)/g)]
    .map((match) => match[1] ?? match[2] ?? "")
    .filter(Boolean)
    .slice(0, 16);
  const bare = prefixes.filter(Boolean).sort((a, b) => b.length - a.length);
  return [...new Set([...explicit, ...bare])].slice(0, 32);
}

/** Shared Markdown URL identity for delivery checks and advisory reply checks; no IO. */
export function observedWebReference(value: string, webDigests: ReadonlySet<string>) {
  // Inline-code delimiters are Markdown syntax, not part of the fetched URL's identity.
  const urls = value.match(/https?:\/\/[^\s<>`]+/gi) ?? [];
  let unobservedUrl = false;
  for (const url of urls) {
    try {
      let target = url.replace(/[.,;，。；]+$/u, "");
      // Strip Markdown's closing delimiter, retaining balanced parentheses in real URL paths.
      while (
        target.endsWith(")") &&
        (target.match(/\)/g)?.length ?? 0) > (target.match(/\(/g)?.length ?? 0)
      )
        target = target.slice(0, -1);
      const digest = sourceDigest(target);
      if (webDigests.has(digest)) return { source: digest, unobservedUrl: false };
      unobservedUrl = true;
    } catch {
      /* Invalid URL is unresolvable. */
    }
  }
  return { source: undefined, unobservedUrl };
}

export async function resolveReference(
  value: string,
  folder: string,
  sources: DeliverySources,
  signal: AbortSignal,
) {
  const { basename, dirname, isAbsolute, relative, resolve, sep } =
    sources.access?.paths ?? pathApi;
  signal.throwIfAborted();
  const { source, unobservedUrl } = observedWebReference(value, sources.webDigests);
  if (source) return { ok: true, source } as const;
  const paths = pathCandidates(value);
  let eligibleMissing = false;
  const excluded = new Set(sources.excludedFiles?.map((path) => resolve(path)));
  // Alias roots affect spelling only; the observed files / declared folders still gate eligibility.
  const aliasRoots = [
    ...new Set([...(sources.artifactRoots ?? []), ...(sources.workspaceRoots ?? [])]),
  ];
  for (const raw of paths) {
    const path = raw
      .replace(/^file:\/\//, "")
      .replace(/#.*$/, "")
      .trim();
    if (!path || path.length > 4096 || /^https?:/i.test(path)) continue;
    const aliasPaths = aliasRoots.flatMap((root) => {
      const target = resolve(root, path);
      const rel = relative(root, target);
      return rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)
        ? [{ root, target }]
        : [];
    });
    for (const file of sources.files) {
      if (excluded.has(resolve(file))) continue;
      const alias = aliasPaths.find(({ target }) => target === resolve(file));
      if (
        !alias &&
        path !== file &&
        path !== basename(file) &&
        resolve(folder, path) !== resolve(file)
      )
        continue;
      eligibleMissing = true;
      try {
        if (
          (
            await deliveryFile(
              alias?.root ?? dirname(file),
              alias?.target ?? basename(file),
              signal,
              undefined,
              sources.access,
            )
          )?.size
        )
          return { ok: true, source: resolve(file) } as const;
      } catch (error) {
        if (sources.access?.remote) throw error;
        signal.throwIfAborted();
      }
    }
    for (const root of sources.folders) {
      const candidates = [
        isAbsolute(path) ? path : resolve(root, path),
        resolve(folder, path),
        ...aliasPaths.map(({ target }) => target),
      ];
      // A Windows reply spells the folder-name prefix with `\` as often as with `/`.
      if (
        path.startsWith(`${basename(root)}/`) ||
        (sep === "\\" && path.startsWith(`${basename(root)}\\`))
      )
        candidates.push(resolve(dirname(root), path));
      for (const candidate of candidates) {
        if (excluded.has(resolve(candidate))) continue;
        try {
          if ((await deliveryFile(root, candidate, signal, undefined, sources.access))?.size)
            return { ok: true, source: resolve(candidate) } as const;
        } catch (error) {
          if (sources.access?.remote) throw error;
          signal.throwIfAborted();
        }
      }
    }
  }
  // Probe metadata only inside the trusted resolution roots, never arbitrary model paths.
  const roots = [...new Set([folder, ...aliasRoots])];
  for (const raw of paths) {
    const path = raw.replace(/^file:\/\//, "").trim();
    if (!path || path.length > 4096 || /^[a-z]+:/i.test(path) || !/[./\\]/.test(path)) continue;
    for (const root of roots) {
      try {
        if (await deliveryFile(root, path, signal, undefined, sources.access))
          return { ok: false, reason: "not_read" } as const;
      } catch {
        signal.throwIfAborted();
      }
    }
  }
  // A slash in unrecognised prose is not proof that a particular file is missing.
  const pathLike = paths.some(
    (path) => /\.[A-Za-z0-9]{1,10}$/.test(path) && !/https?:\/\//i.test(path),
  );
  return {
    ok: false,
    reason:
      eligibleMissing || pathLike ? "missing_file" : unobservedUrl ? "not_read" : "invalid_format",
  } as const;
}
