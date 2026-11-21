import { createHash } from "node:crypto";
import { type BuiltinMethodsPort, skillFingerprint } from "@pibot/brain/kit";
import type { BuiltinMethodTargetsRepo } from "../../store/builtin-methods.ts";
import type { BuiltinContent } from "./load.ts";
import { researchMethodKeys } from "./methods.ts";

/** Stable per key; the eval and the role pack refer to a method by it before any row exists. */
function methodId(key: string) {
  const bytes = createHash("sha256").update(`pibot.builtin-method:${key}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Every released version's fingerprint of a method → its version, from `history.json`,
 * plus what this build ships. Lets the sync tell an untouched older copy (update it) from one the
 * user edited (offer 「有新版本」).
 *
 * One map per language. A copy is provisioned once and then keeps the language it was
 * installed in, so the sync must not treat the other language's fingerprint as a newer
 * version of it — otherwise switching the interface language rewrites the copy on disk.
 */
function knownVersions(
  content: BuiltinContent,
  key: string,
  language: "zh" | "en",
): Map<string, number> {
  const known = new Map<string, number>();
  for (const [version, variants] of Object.entries(content.history?.skills?.[key] ?? {}))
    for (const pair of variants) known.set(pair[language], Number(version));
  for (const pack of content.roles.values())
    for (const pkg of pack[language].skills[0] ?? [])
      if (pkg.folder === key)
        known.set(skillFingerprint(pkg.document, pkg.files), pkg.document.version ?? 0);
  return known;
}

export function builtinMethodSource(
  targets: BuiltinMethodTargetsRepo,
  content: BuiltinContent,
  language: () => "zh" | "en",
): BuiltinMethodsPort {
  const known = new Map(
    researchMethodKeys.flatMap((key) =>
      (["zh", "en"] as const).map(
        (language) => [`${language}:${key}`, knownVersions(content, key, language)] as const,
      ),
    ),
  );
  return {
    skillLabels(botId, groupId, name, description) {
      const role = targets.displayRole(botId, groupId);
      const pack = role ? content.roles.get(role) : undefined;
      if (!pack) return undefined;
      for (const locale of ["zh", "en"] as const) {
        const match = pack[locale].skills[0]?.find(
          (pkg) => pkg.document.name === name && pkg.document.description === description,
        );
        if (!match) continue;
        const zh = pack.zh.skills[0]?.find((pkg) => pkg.folder === match.folder)?.document;
        const en = pack.en.skills[0]?.find((pkg) => pkg.folder === match.folder)?.document;
        if (zh && en)
          return {
            zh: { name: zh.name, description: zh.description },
            en: { name: en.name, description: en.description },
          };
      }
      return undefined;
    },
    methods(botId, groupId, locale = language()) {
      const role = targets.role(botId, groupId);
      if (!role) return [];
      return (content.roles.get(role)?.[locale].skills[0] ?? [])
        .filter((pkg) => researchMethodKeys.includes(pkg.folder))
        .map((pkg) => ({
          id: methodId(pkg.folder),
          key: pkg.folder,
          document: pkg.document,
          files: pkg.files,
          known: known.get(`${locale}:${pkg.folder}`) ?? new Map(),
        }));
    },
    method(key, locale = language()) {
      if (!researchMethodKeys.includes(key)) return undefined;
      for (const pack of content.roles.values()) {
        const pkg = (pack[locale].skills[0] ?? []).find((entry) => entry.folder === key);
        if (pkg) return { id: methodId(key), key, document: pkg.document, files: pkg.files };
      }
      return undefined;
    },
  };
}
