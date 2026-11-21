import { createHash } from "node:crypto";
export const emptyOutputTree = (width: number) =>
  createHash(width === 64 ? "sha256" : "sha1")
    .update("tree 0\0")
    .digest("hex");
/** Fixed commit-only export grammar; it is not an authorization or shell parser. */
export function gitOutputIntent(program: string, args: readonly string[]) {
  if (!/^(?:git|\/(?:usr\/bin|bin|usr\/local\/bin|opt\/homebrew\/bin)\/git)$/.test(program)) return;
  let index = 0;
  let attributes: string | undefined;
  while (true) {
    const arg = args[index] ?? "";
    if (
      ["--no-pager", "--no-replace-objects", "--literal-pathspecs", "--no-optional-locks"].includes(
        arg,
      )
    ) {
      index++;
      continue;
    }
    if (arg.startsWith("--attr-source=") && attributes === undefined) {
      attributes = arg.slice(14);
      index++;
      continue;
    }
    break;
  }
  if (!["--no-pager", "--no-replace-objects"].every((flag) => args.slice(0, index).includes(flag)))
    return;
  const command = args[index++];
  if (!["diff", "show", "format-patch"].includes(command ?? "")) return;
  const flags: string[] = [],
    operands: string[] = [];
  const allowed = new Set([
    "--binary",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--stat",
    "--shortstat",
    "--numstat",
    "--name-only",
    "--name-status",
    "--patch",
    "--no-patch",
  ]);
  for (const arg of args.slice(index)) {
    if (arg.startsWith("-")) {
      if (
        allowed.has(arg) ||
        (command === "show" && /^--format=(?:short|medium|full|fuller|raw|oneline)$/.test(arg)) ||
        (command === "format-patch" &&
          ["--stdout", "--no-signature", "--no-cover-letter", "--no-thread"].includes(arg))
      )
        flags.push(arg);
      else return;
    } else operands.push(arg);
  }
  if (!["--no-ext-diff", "--no-textconv", "--no-color"].every((flag) => flags.includes(flag)))
    return;
  const oids = command === "format-patch" ? operands[0]?.split("..") : operands;
  if (
    !oids ||
    operands.length !== (command === "diff" ? 2 : 1) ||
    oids.length !== (command === "show" ? 1 : 2) ||
    oids.some(
      (oid) => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid) || oid.length !== oids[0]?.length,
    ) ||
    (command === "format-patch" && !flags.includes("--stdout"))
  )
    return;
  if (attributes !== emptyOutputTree(oids[0]?.length ?? 40)) return;
  return { command: command as "diff" | "show" | "format-patch", oids };
}
