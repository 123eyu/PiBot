/**
 * Tables: which hooks and which executable configuration keys an ordinary Git
 * subcommand may run. Over-inclusive on purpose (an extra question is safe, a missed entry is
 * not). Hook sets come from githooks(5) and a marker-hook probe of real Git; unknown subcommands
 * get every hook.
 */
export const ALL_HOOKS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "post-index-change",
] as const;
/** Hooks that run in the repository receiving a push (a local path remote). */
export const RECEIVE_HOOKS = [
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
] as const;

const REF = ["reference-transaction"];
const INDEX = ["post-index-change"];
const GC = ["pre-auto-gc"];
const COMMIT_MSG = ["prepare-commit-msg", "commit-msg"];
const CHECKOUT = ["post-checkout", ...REF, ...INDEX];
const FETCH = [...REF, ...GC];
const MERGE = [
  "pre-merge-commit",
  ...COMMIT_MSG,
  "post-merge",
  "post-checkout",
  ...REF,
  ...INDEX,
  ...GC,
];
const REBASE = [
  "pre-rebase",
  "post-rewrite",
  "post-checkout",
  "pre-commit",
  ...COMMIT_MSG,
  "post-commit",
  ...REF,
  ...INDEX,
  ...GC,
];
const PICK = [...COMMIT_MSG, "post-commit", "post-rewrite", ...REF, ...INDEX, ...GC];

/** Listing forms of branch/tag/remote write nothing and run no hook. */
function listing(subcommand: string, args: readonly string[]) {
  const flags = new Set([
    "-l",
    "--list",
    "-a",
    "--all",
    "-r",
    "--remotes",
    "-v",
    "-vv",
    "--verbose",
    "--show-current",
    "--merged",
    "--no-merged",
    "--contains",
    "--no-contains",
    "--points-at",
    "--column",
    "--no-column",
    "--get-url",
    "get-url",
  ]);
  if (subcommand === "tag" && args.includes("-a")) return false;
  return args.every(
    (arg) => flags.has(arg) || /^--(?:sort|format|merged|contains|points-at)=/.test(arg),
  );
}

export function hooksFor(subcommand: string, args: readonly string[]): readonly string[] {
  const noVerify = args.includes("--no-verify") || (subcommand === "commit" && args.includes("-n"));
  const skip = (hooks: string[], names: string[]) =>
    noVerify ? hooks.filter((hook) => !names.includes(hook)) : hooks;
  switch (subcommand) {
    case "commit":
      return skip(
        ["pre-commit", ...COMMIT_MSG, "post-commit", "post-rewrite", ...REF, ...INDEX, ...GC],
        ["pre-commit", "commit-msg"],
      );
    case "merge":
      return skip(MERGE, ["pre-merge-commit", "commit-msg"]);
    case "pull":
      return [...new Set([...FETCH, ...MERGE, ...REBASE])];
    case "rebase":
      return REBASE;
    case "cherry-pick":
    case "revert":
      return PICK;
    case "am":
      return ["applypatch-msg", "pre-applypatch", "post-applypatch", ...PICK];
    case "checkout":
    case "switch":
    case "restore":
    case "worktree":
    case "clone":
      return CHECKOUT;
    case "fetch":
      return FETCH;
    case "push":
      return ["pre-push", ...REF];
    case "reset":
    case "stash":
      return [...REF, ...INDEX, "post-checkout"];
    case "branch":
    case "tag":
    case "remote":
      return listing(subcommand, args) ? [] : [...REF, ...GC];
    case "update-ref":
    case "symbolic-ref":
    case "notes":
    case "replace":
    case "reflog":
    case "pack-refs":
    case "gc":
    case "maintenance":
      return [...REF, ...GC];
    case "add":
    case "rm":
    case "mv":
    case "status":
    case "update-index":
    case "apply":
    case "read-tree":
    case "sparse-checkout":
    case "checkout-index":
      return INDEX;
    case "send-email":
      return ["sendemail-validate"];
    case "hook":
      return args[0] === "run" && args[1] ? [args[1]] : ALL_HOOKS;
    case "init":
    case "log":
    case "show":
    case "diff":
    case "blame":
    case "grep":
    case "shortlog":
    case "describe":
    case "rev-parse":
    case "rev-list":
    case "ls-files":
    case "ls-tree":
    case "ls-remote":
    case "cat-file":
    case "config":
    case "show-ref":
    case "for-each-ref":
    case "merge-base":
    case "name-rev":
    case "count-objects":
    case "check-ignore":
    case "check-attr":
    case "check-ref-format":
    case "format-patch":
    case "archive":
    case "bundle":
    case "fsck":
    case "var":
    case "version":
    case "help":
    case "whatchanged":
    case "range-diff":
    case "submodule":
    case "credential":
      return [];
    default:
      return ALL_HOOKS;
  }
}

const NETWORK = new Set([
  "clone",
  "fetch",
  "pull",
  "push",
  "ls-remote",
  "remote",
  "submodule",
  "credential",
]);
/** Subcommands that never run filters, diff drivers, editors, signing or fsmonitor. */
const PLAIN = new Set([
  "rev-parse",
  "rev-list",
  "show-ref",
  "for-each-ref",
  "symbolic-ref",
  "var",
  "version",
  "help",
  "ls-tree",
  "merge-base",
  "name-rev",
  "describe",
  "count-objects",
  "check-ignore",
  "check-attr",
  "check-ref-format",
  "ls-files",
  "config",
  "ls-remote",
]);
/** log / shortlog / reflog are plain only without diff, signature or line-range output. */
const LOG_RISK =
  /^(?:-p|-u|-[0-9]*[pu]|--patch|--stat|--numstat|--shortstat|--dirstat|--compact-summary|--summary|--show-signature|-[GSL]|--word-diff|--color-words|--cc|--ext-diff|--textconv|--check|--binary|--full-index|--follow)/;
function plain(subcommand: string, args: readonly string[]) {
  if (PLAIN.has(subcommand)) return true;
  if (subcommand === "cat-file") return !args.some((arg) => /^--(?:textconv|filters)/.test(arg));
  if (["log", "shortlog", "reflog", "show-branch"].includes(subcommand))
    return !args.some((arg) => LOG_RISK.test(arg));
  if (["branch", "tag", "remote"].includes(subcommand)) return listing(subcommand, args);
  return false;
}

const falsy = /^(?:false|no|off|0)$/i;
const truthy = /^(?:true|yes|on|1)$/i;

/**
 * Whether one parsed project key names a program this subcommand may run. `value` is used only to
 * recognise disabled/builtin forms and shell-alias syntax; it is never returned or logged.
 */
export function keyRunsFor(
  key: string,
  value: string | undefined,
  subcommand: string,
  args: readonly string[],
): boolean {
  const k = key.toLowerCase();
  const variable = k.slice(k.lastIndexOf(".") + 1);
  const section = k.slice(0, k.indexOf("."));
  const network = NETWORK.has(subcommand);
  if (section === "credential" && variable === "helper") return network && !!value;
  if (
    k === "core.sshcommand" ||
    k === "core.gitproxy" ||
    k === "core.askpass" ||
    (section === "remote" && ["uploadpack", "receivepack", "vcs"].includes(variable)) ||
    (section === "protocol" && variable === "allow" && !/^never$/i.test(value ?? ""))
  )
    return network;
  if (section === "remote" && (variable === "url" || variable === "pushurl"))
    return network && /^[a-z0-9+.-]+::/i.test(value ?? "");
  if (section === "url" && /\.(?:push)?insteadof$/.test(k) && k.slice(4).includes("::"))
    return network;
  if (k === "init.templatedir") return subcommand === "init" || subcommand === "clone";
  if (k === "core.fsmonitor")
    return !!value && !falsy.test(value) && !truthy.test(value) && !plain(subcommand, args);
  if (section === "submodule" && variable === "update")
    return (value ?? "").startsWith("!") && !plain(subcommand, args);
  if (
    (section === "filter" && ["clean", "smudge", "process"].includes(variable)) ||
    k === "diff.external" ||
    (section === "diff" && ["command", "textconv"].includes(variable) && k !== "diff.external") ||
    (section === "merge" && variable === "driver") ||
    (section === "gpg" && variable === "program") ||
    k === "gpg.ssh.defaultkeycommand" ||
    k === "core.editor" ||
    k === "sequence.editor" ||
    k === "core.alternaterefscommand" ||
    (section === "trailer" && (variable === "command" || variable === "cmd"))
  )
    return !!value && !plain(subcommand, args);
  return false;
}

/** Git's own subcommands; anything else may be an alias or an external `git-<name>` program. */
export function builtinSubcommand(subcommand: string) {
  return hooksFor(subcommand, []) !== ALL_HOOKS || ["hook"].includes(subcommand);
}

/**
 * Husky v9.1 (verified byte-identical in 9.1.6 and 9.1.7): every `.husky/_/<hook>` is this stub and
 * `.husky/_/h` exits 0 unless the user script `.husky/<hook>` exists. Older or edited copies are
 * not recognised and are treated as ordinary hooks.
 */
export const HUSKY_STUB_SHA256 = "34fe496008be71d8fdd446b2cce81e4bb0406109c130eafc583fbd9fe33244e2";
export const HUSKY_RUNNER_SHA256 =
  "70200b200ca709b0622784f93839a5b2872333a917a09afddefd7dc2d8cdc680";
