import { powershellDirectoryWrites } from "../commands/powershell-directories.ts";
import { windowsProtectedPathNames } from "../paths/protected-paths.ts";
import {
  type CommandPathScope,
  commandLiteralPaths,
  isWritableCommandPath,
} from "./command-path-risk.ts";

const MAX_FRAGMENTS = 16;
const MAX_FRAGMENT_LENGTH = 160;
const boundary = /[\\\s"'`;&|(){}=:%]/;
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Conservative text hints only: no shell interpretation, readonly proof or permission grant. */
export function scanWindowsCommand(
  command: string,
  protectedRoots: readonly string[] = [],
  scope: CommandPathScope = { writeRoots: [], denyWriteRoots: [] },
  verifiedPaths: ReadonlySet<string> = new Set(),
  cwd?: string,
) {
  const fragments = new Set<string>();
  let privilegeEscalation = false;
  const add = (value: string) => {
    if (fragments.size < MAX_FRAGMENTS) fragments.add(value.slice(0, MAX_FRAGMENT_LENGTH));
  };
  for (const match of command.matchAll(
    /\b(?:sudo|runas)(?:\.exe)?\b|-verb\s*(?:[:=]\s*)?["']?runas\b/gi,
  )) {
    privilegeEscalation = true;
    add(match[0]);
  }
  for (const match of command.matchAll(
    /\b(?:remove-item|ri|rm|rmdir|rd|del|erase)\b(?:[ \t]+(?:-recurse\b|-force\b|-[rf]+\b|\/[sq]\b))*/gi,
  ))
    add(match[0]);
  // Slash folding preserves offsets so fragments remain the exact text shown by the caller.
  const folded = command.replaceAll("/", "\\");
  const paths = commandLiteralPaths(command);
  for (const name of [...windowsProtectedPathNames(), ...protectedRoots]) {
    const needle = name.replaceAll("/", "\\").replace(/\\+$/, "");
    if (!needle) continue;
    let pathIndex = 0;
    for (const match of folded.matchAll(new RegExp(escapePattern(needle), "gi"))) {
      const start = match.index;
      const end = start + needle.length;
      if (
        (start === 0 || boundary.test(folded[start - 1] ?? "")) &&
        (end === folded.length || boundary.test(folded[end] ?? ""))
      ) {
        while (paths[pathIndex] && (paths[pathIndex]?.end ?? 0) <= start) pathIndex++;
        const literal = paths[pathIndex];
        if (
          literal &&
          literal.start <= start &&
          literal.end >= end &&
          verifiedPaths.has(literal.path) &&
          isWritableCommandPath(literal.path, "win32", scope)
        )
          continue;
        add(command.slice(start, end));
      }
    }
  }
  for (const match of command.matchAll(
    /%(?:systemroot|windir|programfiles(?:\(x86\))?|programdata)%|\$env:(?:systemroot|windir|programfiles|programdata)\b/gi,
  ))
    add(match[0]);
  if (cwd) {
    const directoryWrites = powershellDirectoryWrites(command, cwd);
    for (const path of directoryWrites.writes)
      if (!isWritableCommandPath(path, "win32", scope)) add(path);
    if (directoryWrites.unknownWrite) add("unknown_command_directory");
  }
  return { privilegeEscalation, fragments: [...fragments] };
}
