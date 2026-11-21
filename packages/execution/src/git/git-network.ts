import { randomUUID } from "node:crypto";
import { ExecError, type NetworkSettings } from "../core/types.ts";
import { gitHardening } from "./git-program.ts";

export interface GitNetworkOperation {
  kind: "sync";
  action: "push" | "pull";
  url: string;
  branch: string;
  head: string;
  /** Core-issued temporary ref; the server never chooses the local destination. */
  temporaryRef: string;
  filters: string[];
}
export function gitNetworkBranch(value: string) {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(value) ||
    value === "HEAD" ||
    value.includes("..") ||
    value.includes("//") ||
    value.split("/").some((part) => !part || part.endsWith(".") || part.endsWith(".lock"))
  )
    throw new ExecError("invalid_input");
  return value;
}
/** Remote URLs remain in core; no helper program, local file, redirect or credential in argv. */
export function gitNetworkURL(value: string) {
  if (value.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new ExecError("invalid_input");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ExecError("invalid_input");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname)
  )
    throw new ExecError("invalid_input");
  return url;
}
export function gitNetworkSettings(operations: { kind: string }[]): NetworkSettings {
  if (operations.some((operation) => operation.kind === "sync") && operations.length !== 1)
    throw new ExecError("invalid_input");
  return {
    allowAll: false,
    domains: [
      ...new Set(
        operations
          .filter((operation): operation is GitNetworkOperation => operation.kind === "sync")
          .map((operation) => gitNetworkURL(operation.url).hostname),
      ),
    ],
  };
}
export function gitNetworkSteps(
  platform: NodeJS.Platform,
  program: string,
  operation: GitNetworkOperation,
) {
  if (platform === "win32") throw new ExecError("isolation_unavailable");
  const url = gitNetworkURL(operation.url).href,
    branch = gitNetworkBranch(operation.branch);
  if (
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(operation.head) ||
    !/^refs\/pibot-sync\/[0-9a-f-]{36}$/.test(operation.temporaryRef) ||
    operation.filters.length > 128 ||
    operation.filters.some((name) => !/^[A-Za-z0-9_.-]{1,200}$/.test(name))
  )
    throw new ExecError("invalid_input");
  const hardening = [
    ...gitHardening(platform, program),
    "--no-replace-objects",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "http.followRedirects=false",
    "-c",
    "http.sslVerify=true",
    "-c",
    "http.extraHeader=",
    "-c",
    "http.cookieFile=",
    "-c",
    "http.saveCookies=false",
    "-c",
    "core.askPass=",
    "-c",
    "push.gpgSign=false",
    "-c",
    "push.followTags=false",
    "-c",
    "push.recurseSubmodules=no",
    "-c",
    "fetch.recurseSubmodules=false",
    "-c",
    "merge.autoStash=false",
    ...operation.filters.flatMap((name) => [
      "-c",
      `filter.${name}.clean=`,
      "-c",
      `filter.${name}.smudge=`,
      "-c",
      `filter.${name}.process=`,
      "-c",
      `filter.${name}.required=false`,
    ]),
  ];
  const git = (...args: string[]) => ({ git: [...hardening, ...args] });
  return operation.action === "push"
    ? [
        git(
          "push",
          "--porcelain",
          "--no-verify",
          "--",
          url,
          `${operation.head}:refs/heads/${branch}`,
        ),
      ]
    : [
        git(
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-write-fetch-head",
          "--",
          url,
          `refs/heads/${branch}:${operation.temporaryRef}`,
        ),
        git("merge", "--ff-only", "--no-edit", "--no-autostash", operation.temporaryRef),
        git("update-ref", "-d", operation.temporaryRef),
      ];
}
export const gitTemporaryRef = () => `refs/pibot-sync/${randomUUID()}`;
