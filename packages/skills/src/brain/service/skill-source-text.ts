import { readScannedFile, type ScannedSkillPackage } from "@pibot/brain/kit";
import { RpcError, SKILL_BODY_MAX_BYTES } from "@pibot/skills-contract/full";

/** The scanner validates UTF-8, but its display decoder omits the BOM. Read the bounded original. */
export async function sourceSkillText(
  pack: ScannedSkillPackage,
  signal: AbortSignal,
  touch: () => void,
) {
  return (
    await readScannedFile(pack.skillFile, signal, SKILL_BODY_MAX_BYTES + 64 * 1024, touch)
  ).toString("utf8");
}

/** Preserve YAML we do not understand, including comments, lists, line endings and the BOM. */
export function replaceImportedBody(text: string, body: string) {
  const prefix =
    /^\uFEFF?---(?:\r\n|\r|\n)[\s\S]*?(?:\r\n|\r|\n)---[^\r\n]*(?:(?:\r\n|\r|\n))*/.exec(text)?.[0];
  const result = prefix
    ? `${prefix}${/[\r\n]$/.test(prefix) ? "" : "\n"}${body}`
    : `${text.startsWith("\uFEFF") ? "\uFEFF" : ""}${body}`;
  // A large source header must not make a valid new body unreadable by the bounded file reader.
  if (Buffer.byteLength(result) > SKILL_BODY_MAX_BYTES + 64 * 1024)
    throw new RpcError(-32602, "skill_import_too_large");
  return result;
}
