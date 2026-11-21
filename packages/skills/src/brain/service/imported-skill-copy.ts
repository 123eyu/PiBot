import {
  importedDocument,
  type PackageFile,
  parseSkillFile,
  type SkillsPort,
  skillPackage,
} from "@pibot/brain/kit";
import {
  RpcError,
  RpcErrorCodes,
  SKILL_IMPORT_FILE_MAX_BYTES,
  SKILL_IMPORT_MAX_BYTES,
  SKILL_IMPORT_MAX_FILES,
} from "@pibot/skills-contract/full";
import type { SkillServices } from "./skill-services.ts";

/** Uses the same own-skill validation, queue, rollback and audit as the editor's import. */
export async function copyImportedSkill(
  services: SkillServices,
  ...[botId, input, options]: Parameters<NonNullable<SkillsPort["copyImported"]>>
): Promise<void> {
  options.signal.throwIfAborted();
  const locale = input.locales.en;
  const pack =
    input.scannedPackage ??
    skillPackage([
      { path: "SKILL.md", data: Buffer.from(locale.skillMd) },
      ...(locale.files ?? []).map((file) => ({
        path: file.path,
        data: Buffer.from(file.content),
      })),
    ]);
  if (
    pack.totalBytes > SKILL_IMPORT_MAX_BYTES ||
    pack.files.length + 1 > SKILL_IMPORT_MAX_FILES ||
    (!input.scannedPackage &&
      pack.files.some((file) => "data" in file && file.data.length > SKILL_IMPORT_FILE_MAX_BYTES))
  )
    throw new RpcError(RpcErrorCodes.invalidParams, "skill_package_too_large");
  // The existing skill importer validates metadata and keeps scripts as inert resources.
  const document = importedDocument(parseSkillFile(pack.skillText), input.id);
  await services.skillsFor(options.groupId).create(botId, document, "imported", {
    uniqueName: true,
    ...(input.scannedPackage
      ? { scannedPackage: input.scannedPackage, copySignal: options.signal }
      : {
          originalSkillText: locale.skillMd,
          files: pack.files.filter((file): file is PackageFile => "data" in file),
        }),
    onProgress: options.onProgress,
    reason: "imported",
    queueSignal: options.signal,
    assertCurrent: () => {
      options.signal.throwIfAborted();
      options.assertCurrent();
    },
    afterInsert: (record) => options.afterInsert(record.id),
  });
}
