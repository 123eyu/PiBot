import { posix, win32 } from "node:path";
import type { Platform } from "@pibot/policy";

/** Compile trusted root prefixes once, keeping the same normalization as containsPath. */
export function pathPrefixMatcher(platform: Platform) {
  const api = platform === "win32" ? win32 : posix;
  const normalize = (path: string) => api.resolve(platform === "win32" ? path.toLowerCase() : path);
  const roots = new Map<string, { path: string; prefix: string }>();
  return (value: string) => {
    const path = normalize(value);
    return (root: string) => {
      let key = roots.get(root);
      if (!key) {
        const path = normalize(root);
        key = { path, prefix: path.endsWith(api.sep) ? path : `${path}${api.sep}` };
        roots.set(root, key);
      }
      return path === key.path || path.startsWith(key.prefix);
    };
  };
}

interface PrefixNode {
  children: Map<string, PrefixNode>;
  region?: number;
}

/** Nested boundaries form a chain: its deepest root uniquely identifies the containing set. */
export function pathRegion(roots: readonly string[], platform: Platform) {
  const api = platform === "win32" ? win32 : posix;
  const parts = (value: string) =>
    api
      .resolve(platform === "win32" ? value.toLowerCase() : value)
      .split(api.sep)
      .filter(Boolean);
  const tree: PrefixNode = { children: new Map() };
  roots.forEach((root, region) => {
    let node = tree;
    for (const part of parts(root)) {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.region = region;
  });
  return (path: string) => {
    let node = tree;
    let region = node.region ?? -1;
    for (const part of parts(path)) {
      const next = node.children.get(part);
      if (!next) break;
      node = next;
      region = node.region ?? region;
    }
    return region;
  };
}
