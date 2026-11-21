export const PERMISSION_OUTPUT_NOTICE =
  "部分目录无权限读取，其余结果完整 / Some directories could not be read due to permissions; the remaining results are complete.\n";

/** Classify every stderr line before head/tail truncation, without retaining an unbounded line. */
export class PermissionErrors {
  private pending = "";
  private seen = false;
  private other = false;

  push(text: string) {
    if (this.other) return;
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      this.line(this.pending + text.slice(start, end));
      this.pending = "";
      start = end + 1;
      if (this.other) return;
    }
    this.pending += text.slice(start);
    if (this.pending.length > 8192) {
      this.other = true;
      this.pending = "";
    }
  }

  private line(value: string) {
    if (!value.trim()) return;
    this.seen = true;
    // These are output hints, never evidence of authorization or of unreadable contents.
    if (
      value.length > 8192 ||
      !/^.+: (?:Permission denied|Operation not permitted)\r?$/.test(value)
    )
      this.other = true;
  }

  finish() {
    this.line(this.pending);
    this.pending = "";
    return this.seen && !this.other;
  }
}

export function timeoutOutput(output: string, seconds: number) {
  return `已超时（${seconds} 秒），以下是部分输出 / Timed out (${seconds}s); partial output follows:\n${output}`;
}

const DENIAL = /operation not permitted|read-only file system/i;
// Quoted paths cover Node (`EPERM: operation not permitted, open 'dep/.idea/x'`), GNU tools, Git.
// A quote right after a letter is an apostrophe (`Can't create '…'`), never an opening quote.
const QUOTED = /(?<![\p{L}\p{N}])['"‘“`]([^'"’”`\n]{1,4096})['"’”`]/gu;
const PATHLIKE = /^(?:[^\s].*\/.*[^\s]|\.[^\s/]+)$/;
// BSD tools and bash: `touch: x/.vscode/a: Operation not permitted`.
const BARE =
  /(?:^|[\s:])((?:\/|\.{1,2}\/)?[^\s:'"`]*\/[^\s:'"`]*|\.[^\s:/'"`]+)\s*:\s*(?:operation not permitted|read-only file system)/i;
// pnpm wraps long paths over indented lines: `to "/private/\n      var/…/x": Operation not permitted`.
const QUOTED_BEFORE_DENIAL =
  /['"‘“`]([^'"’”`]{1,4096})['"’”`]\s*:\s*(?:operation not permitted|read-only file system)/gi;
// unzip: `error:  cannot create unzipped/x/.idea/a` then an indented `Operation not permitted`.
const DENIAL_ONLY = /^\s+(?:operation not permitted|read-only file system)\s*$/i;
const LAST_PATH = /(?:^|\s)((?:\/|\.{1,2}\/)?[^\s'"`]*\/[^\s'"`]+)\s*$/;
// Blocks without a path. Each pattern names one fixed rule; the text is never passed on.
const SIGNALS: {
  pattern: RegExp;
  kind: "network" | "system_service";
  rule: string;
  target?: RegExp;
}[] = [
  {
    pattern: /connect to host (\S+) port (\d+): operation not permitted/i,
    kind: "network",
    rule: "socket",
    target: /connect to host (\S+ port \d+)/i,
  },
  {
    pattern: /CONNECT tunnel failed, response 403|proxy[^\n]{0,40}\b403\b/i,
    kind: "network",
    rule: "proxy_denied",
  },
  { pattern: /\blisten EPERM\b|\bbind EPERM\b/i, kind: "network", rule: "local_bind" },
  {
    pattern: /NSOSStatusErrorDomain Code=-600|\bprocNotFound\b|-1743\b/,
    kind: "system_service",
    rule: "apple_events",
  },
];
// Python names no path for a socket refusal; its traceback shows the call just before.
const SOCKET_CALL = /\.(?:bind|listen|connect)\(/;
const BARE_ERRNO = /PermissionError: \[Errno 1\] Operation not permitted\s*$/;
const WRAP_LINES = 8;
const MAX_PATHS = 16;

export interface DenialSignal {
  kind: "network" | "system_service";
  rule: string;
  target: string;
}

/**
 * Candidate paths and path-less signals from denial lines, collected before head/tail truncation.
 * They are hints from untrusted output: only a match against the call's own rules (or a failed
 * sandboxed command for a signal) makes one a sandbox block.
 */
export class SandboxDenials {
  private pending = "";
  private readonly found = new Set<string>();
  private readonly signals = new Map<string, DenialSignal>();
  private readonly recent: string[] = [];

  push(text: string) {
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      this.line(this.pending + text.slice(start, end));
      this.pending = "";
      start = end + 1;
    }
    this.pending = (this.pending + text.slice(start)).slice(-8192);
  }

  private line(value: string) {
    if (value.length > 8192) return;
    const previous = this.recent.at(-1);
    this.recent.push(value);
    if (this.recent.length > WRAP_LINES) this.recent.shift();
    for (const signal of SIGNALS)
      if (signal.pattern.test(value))
        this.signal(signal.kind, signal.rule, signal.target?.exec(value)?.[1] ?? signal.rule);
    if (!DENIAL.test(value)) return;
    if (BARE_ERRNO.test(value) && this.recent.some((line) => SOCKET_CALL.test(line)))
      this.signal("network", "local_bind", "socket");
    for (const match of value.matchAll(QUOTED))
      if (match[1] && PATHLIKE.test(match[1])) this.add(match[1]);
    const bare = BARE.exec(value)?.[1];
    if (bare) this.add(bare);
    if (DENIAL_ONLY.test(value) && previous) this.add(LAST_PATH.exec(previous)?.[1]);
    if (/^\s/.test(value)) {
      const joined = this.recent.map((line) => line.trimStart()).join("");
      for (const match of joined.matchAll(QUOTED_BEFORE_DENIAL))
        if (match[1] && PATHLIKE.test(match[1])) this.add(match[1]);
    }
  }

  private signal(kind: DenialSignal["kind"], rule: string, target: string) {
    if (this.signals.size < MAX_PATHS)
      this.signals.set(`${kind}\0${rule}\0${target}`, { kind, rule, target });
  }

  private add(path: string | undefined) {
    if (path && this.found.size < MAX_PATHS) this.found.add(path);
  }

  finish(): { paths: string[]; signals: DenialSignal[] } {
    this.line(this.pending);
    this.pending = "";
    return { paths: [...this.found], signals: [...this.signals.values()] };
  }
}

/**
 * What CLIs print when they found no login or config (aws, gh, kubectl, gcloud, az,
 * docker). Matched on every line before truncation, because `| head` or a long listing may cut
 * it away; only a yes/no leaves this class, never the line.
 */
const LOGIN_MISSING =
  /unable to locate credentials|could not find default credentials|no credentials|credentials? (?:not found|missing)|not logged in(?:to)?|you must (?:be logged in|log in)|current-context is not set|no current context|reauthentication required|please (?:log|sign) ?in|run [`'"]?(?:aws configure|aws sso login|gh auth login|gcloud auth login|az login|docker login)/i;

export class LoginHints {
  private pending = "";
  private found = false;

  push(text: string) {
    if (this.found) return;
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      if (LOGIN_MISSING.test((this.pending + text.slice(start, end)).slice(0, 2048))) {
        this.found = true;
        this.pending = "";
        return;
      }
      this.pending = "";
      start = end + 1;
    }
    this.pending = (this.pending + text.slice(start)).slice(-2048);
  }

  finish() {
    if (!this.found && this.pending) this.found = LOGIN_MISSING.test(this.pending);
    this.pending = "";
    return this.found;
  }
}
