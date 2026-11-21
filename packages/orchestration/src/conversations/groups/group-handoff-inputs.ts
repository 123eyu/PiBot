import { localWorkspaceFiles, type WorkspaceFileAccess } from "@pibot/brain/orchestration-kit";
import type { SkillContract } from "@pibot/protocol-base";

// Paths written in Chinese or English prose: stop at whitespace, CJK punctuation and quotes.
const PATH = /(?:~|[A-Za-z]:)?[\\/][^\s，。、；：！？）)（("'`“”‘’<>]+/g;
const MAX_PATHS = 12;
const STAT_MS = 3_000;

/**
 * Inputs for a member's contract skill when a free-form assignment (outside a workflow)
 * names its material only in prose ("用 ~/Documents/…/期-2026-09 里的 CSV"). Each folder / file
 * input takes the first mentioned path of its kind that exists; nothing is guessed beyond that,
 * the workflow's own pre-checks still run, and policy still decides every read.
 */
export async function inputsFromText(
  contract: SkillContract,
  text: string,
  signal: AbortSignal,
  files: WorkspaceFileAccess = localWorkspaceFiles,
): Promise<Record<string, string>> {
  const wanted = contract.inputs.filter(
    (input) => input.kind === "folder" || input.kind === "file",
  );
  if (!wanted.length) return {};
  const found: { path: string; folder: boolean }[] = [];
  for (const raw of [...new Set(text.match(PATH) ?? [])].slice(0, MAX_PATHS)) {
    const path = files.resolveInput(raw);
    if (!path) continue;
    const info = await files.probe(path, AbortSignal.any([signal, AbortSignal.timeout(STAT_MS)]));
    signal.throwIfAborted();
    if (info) found.push({ path, folder: info.kind === "directory" });
  }
  const inputs: Record<string, string> = {};
  for (const input of wanted) {
    const match = found.find((item) => item.folder === (input.kind === "folder"));
    if (match) inputs[input.name] = match.path;
  }
  return inputs;
}
