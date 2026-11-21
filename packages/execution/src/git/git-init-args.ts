import { isAbsolute, resolve } from "node:path";
import { ExecError } from "../core/types.ts";

export interface GitInitialization {
  program: string;
  argv: string[];
  primary: { canonicalPath: string; device: string | null; inode: string | null };
  /** Synchronous brain-owned check; an edited primary/permission/group invalidates preparation. */
  assertAuthorized(): void;
}

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

/** Only exec's validated plan may derive this fixed command; it is never a model setup tool. */
export function gitDirectoryCreationCommand(gitDir: string) {
  // -m affects only the final mkdir -p component; the fixed umask also protects new parents.
  return `umask 077; exec ${["/bin/mkdir", "-p", "-m", "700", "--", gitDir].map(quote).join(" ")}`;
}

/** Structured argv supplied by the authorized brain port, never inferred from arbitrary shell text. */
export function gitInitArguments(argv: string[], cwd: string, program = "git") {
  if (!/^(?:git|\/(?:usr\/bin|bin|usr\/local\/bin|opt\/homebrew\/bin)\/git)$/.test(program))
    throw new ExecError("invalid_input");
  let directory = cwd;
  const directories = [cwd];
  let unsupportedGlobal = false;
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] as string;
    if (["--no-pager", "--literal-pathspecs", "--no-optional-locks"].includes(arg)) index++;
    else if (arg === "-C" || (arg.startsWith("-C") && arg.length > 2)) {
      const value = arg === "-C" ? argv[++index] : arg.slice(2);
      if (value === undefined) throw new ExecError("invalid_input");
      if (value) directory = resolve(directory, value);
      directories.push(directory);
      index++;
    } else if (["-c", "--git-dir", "--work-tree"].includes(arg)) {
      unsupportedGlobal = true;
      if (argv[++index] === undefined) return undefined;
      index++;
    } else if (
      arg.startsWith("-c") ||
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=") ||
      arg === "--bare"
    ) {
      unsupportedGlobal = true;
      index++;
    } else break;
  }
  if (argv[index] !== "init") return undefined;
  if (unsupportedGlobal) throw new ExecError("invalid_input");
  const initAt = index++;
  let template = false;
  let destination: string | undefined;
  let operands = false;
  for (; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg.includes("\0")) throw new ExecError("invalid_input");
    if (!operands && arg === "--") operands = true;
    else if (!operands && (arg === "--quiet" || /^-q+$/.test(arg))) continue;
    else if (
      !operands &&
      ["--template", "--initial-branch", "--object-format", "--ref-format", "-b"].includes(arg)
    ) {
      template ||= arg === "--template";
      if (argv[++index] === undefined) throw new ExecError("invalid_input");
    } else if (
      !operands &&
      /^(?:--(?:template|initial-branch|object-format|ref-format)=|-q*b.).*/.test(arg)
    )
      template ||= arg.startsWith("--template=");
    else if (!operands && /^-q+b$/.test(arg)) {
      if (argv[++index] === undefined) throw new ExecError("invalid_input");
    } else if (!operands && (arg === "--shared" || arg.startsWith("--shared="))) continue;
    else if (!operands && arg.startsWith("-")) throw new ExecError("invalid_input");
    else {
      if (destination !== undefined) throw new ExecError("invalid_input");
      destination = arg;
    }
  }
  const target = resolve(directory, destination ?? ".");
  if (!isAbsolute(target)) throw new ExecError("invalid_input");
  const command = [...argv];
  if (!template) command.splice(initAt + 1, 0, "--template=");
  // Fix the executable as well as argv; no wrapper or earlier shell command is run.
  return {
    target,
    directories,
    command: [program, ...command].map(quote).join(" "),
    emptyTemplate: !template,
  };
}
