import type { BuiltinMethodsPort, RegisterRpc } from "@pibot/brain/kit";
import { RpcError, RpcErrorCodes, type SkillLabels } from "@pibot/skills-contract/full";
import { transaction } from "@pibot/storage";
import { SkillCatalogRepo } from "../../store/index.ts";
import { skillFolder } from "./skill-files.ts";
import { readImportSource } from "./skill-import.ts";
import type { SkillService } from "./skill-service.ts";
import type { SkillServices } from "./skill-services.ts";

const invalid = (message: string) => new RpcError(RpcErrorCodes.invalidParams, message);

/**
 * One skill folder of another AI tool, saved as `botId`'s own skill and turned off.
 * The folder goes through the same reader as a picked folder (size, file count, no links, scripts
 * stay inert), so the untrusted-package rules do not change with the entry point. The name is
 * kept unless any Bot already uses it, so giving it to another Bot later cannot clash.
 */
export async function bringOverSkill(
  services: SkillServices,
  catalog: SkillCatalogRepo,
  botId: string,
  folder: string,
  origin: { tool: string; key: string },
  signal: AbortSignal,
): Promise<{ name: string }> {
  const source = await readImportSource(
    folder,
    "folder",
    AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  );
  let name: string;
  try {
    name = catalog.freeName(source.document.name);
  } catch {
    throw invalid("skill_name_exists");
  }
  const skill = await services.skills.create(botId, { ...source.document, name }, "imported", {
    enabled: false,
    reason: "imported",
    scannedPackage: source.pack,
    copySignal: signal,
    queueSignal: signal,
    afterInsert: (record) => catalog.setOrigin(record.id, origin),
  });
  return { name: skill.name };
}

/**
 * Amendment: a built-in method is only ever viewed and assigned. Giving it to a Bot goes
 * through the trusted built-in install (the copy stays bound to the method, keeps receiving
 * updates and is not an editable or exportable user skill); taking it away turns that copy off.
 */
async function assignBuiltin(
  target: SkillService,
  methods: () => BuiltinMethodsPort | undefined,
  key: string,
  botId: string,
  enabled: boolean,
  signal: AbortSignal,
) {
  const own = target.builtins.repo.get(botId, key);
  if (own) {
    if (own.enabled !== enabled) target.setEnabled(own.id, enabled);
    return;
  }
  if (!enabled) return;
  const method = methods()?.method?.(key);
  if (!method) throw invalid("skill_builtin_unavailable");
  // An explicit 「给 Bot 用」 overrides an earlier removal of this method from this Bot.
  target.builtins.repo.unmarkRemoved(botId, key);
  await target.builtins.install(
    botId,
    { key, document: method.document, files: method.files },
    signal,
  );
}

/**
 * Gives a Bot a catalog skill: turns on its own copy of that name when it has one (the same row
 * merges only identical name + description, so a different skill of that name is refused), or
 * copies the representative's package into it. Taking it away only turns that copy off.
 * With `targetGroupId` the same happens in that group's store for the Bot as a member.
 */
async function assign(
  services: SkillServices,
  catalog: SkillCatalogRepo,
  methods: () => BuiltinMethodsPort | undefined,
  input: {
    skillId: string;
    groupId?: string;
    targetGroupId?: string;
    botId: string;
    enabled: boolean;
  },
  signal: AbortSignal,
) {
  const sourceService = services.skillsFor(input.groupId);
  const source = sourceService.require(input.skillId);
  const target = services.skillsFor(input.targetGroupId);
  target.activeBot(input.botId);
  if (source.builtinKey) {
    await assignBuiltin(target, methods, source.builtinKey, input.botId, input.enabled, signal);
    return { ok: true as const };
  }
  const own = target.repo.findByName(input.botId, source.name);
  if (own) {
    if (own.description !== source.description || own.builtinKey)
      throw invalid("skill_name_exists");
    if (own.enabled !== input.enabled) target.setEnabled(own.id, input.enabled);
    return { ok: true as const };
  }
  if (!input.enabled) return { ok: true as const };
  const pack = source.packageId
    ? undefined
    : await readImportSource(
        skillFolder(sourceService.deps.dataDir, source.botId, sourceService.location(source)),
        "folder",
        AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      );
  // Name and description come from the row (what the catalog shows), body from the files.
  const document = await sourceService.document(source, signal);
  // The origin label lives on private rows only (`skills.origin_tool`); group rows have no column.
  const origin = input.groupId || input.targetGroupId ? undefined : catalog.origin(source.id);
  await target.create(input.botId, document, source.source, {
    reason: "imported",
    scannedPackage: pack?.pack,
    preserveSource: sourceService.preservesSource(source),
    packageId: source.packageId,
    copySignal: signal,
    queueSignal: signal,
    ...(source.importSource ? { importSource: source.importSource } : {}),
    ...(origin ? { afterInsert: (record) => catalog.setOrigin(record.id, origin) } : {}),
  });
  return { ok: true as const };
}

/**
 * The connections page lists copies by the labels they were installed with; a built-in
 * row also carries the app's labels in both languages so it can follow the interface language.
 * Labels come from the shipped packs, never from the copies, so no skill content changes.
 */
function builtinLabelReader(methods: BuiltinMethodsPort | undefined) {
  const find = methods?.method;
  const labels = new Map<string, SkillLabels | undefined>();
  return (key: string): SkillLabels | undefined => {
    if (!find) return undefined;
    if (labels.has(key)) return labels.get(key);
    const zh = find(key, "zh");
    const en = find(key, "en");
    const value =
      zh && en
        ? {
            zh: { name: zh.document.name, description: zh.document.description },
            en: { name: en.document.name, description: en.document.description },
          }
        : undefined;
    labels.set(key, value);
    return value;
  };
}

function withBuiltinLabels(
  page: ReturnType<SkillCatalogRepo["page"]>,
  labelsOf: ReturnType<typeof builtinLabelReader>,
  services: SkillServices,
): ReturnType<SkillCatalogRepo["page"]> {
  return {
    ...page,
    items: page.items.map((item) => {
      const value = item.builtinKey
        ? labelsOf(item.builtinKey)
        : item.origin === "team"
          ? services
              .skillsFor(item.groupId)
              .roleSkillLabels(services.skillsFor(item.groupId).require(item.skillId))
          : undefined;
      return value ? { ...item, builtinLabels: value } : item;
    }),
  };
}

function matchesLabels(labels: SkillLabels | undefined, query: string): boolean {
  return (
    labels !== undefined &&
    Object.values(labels).some(
      (label) =>
        label.name.toLowerCase().includes(query) || label.description.toLowerCase().includes(query),
    )
  );
}

export function registerSkillCatalogRpc(
  handle: RegisterRpc,
  services: SkillServices,
  catalog: SkillCatalogRepo,
  methods: () => BuiltinMethodsPort | undefined,
  signal: AbortSignal,
) {
  handle("skills.catalog", async (params) => {
    const source = methods();
    const labelsOf = builtinLabelReader(source);
    const query = params.query?.trim().toLowerCase();
    const matchingKeys = query
      ? catalog.builtinKeys().filter((key) => matchesLabels(labelsOf(key), query))
      : [];
    const matchingRoleCopyIds: string[] = [];
    if (query && source?.skillLabels) {
      for (const copy of catalog.roleCopies()) {
        const labels = source.skillLabels(copy.botId, copy.groupId, copy.name, copy.description);
        if (matchesLabels(labels, query)) matchingRoleCopyIds.push(copy.id);
      }
    }
    return withBuiltinLabels(
      catalog.page(params, matchingKeys, matchingRoleCopyIds),
      labelsOf,
      services,
    );
  });
  handle("skills.catalogAssign", async (params, context) => {
    const started = performance.now();
    let outcome = "failed";
    try {
      const result = await assign(
        services,
        catalog,
        methods,
        params,
        AbortSignal.any([signal, context.signal]),
      );
      outcome = "ok";
      return result;
    } finally {
      services.skills.deps.logger.info(
        JSON.stringify({
          module: "skills",
          event: "catalog_assign",
          botId: params.botId,
          groupId: params.targetGroupId,
          durationMs: Math.round(performance.now() - started),
          outcome,
        }),
      );
    }
  });
  // Deleting from the
  // overview removes every copy, the Bots' own and every group's.
  handle("skills.catalogDelete", ({ skillId, groupId }) =>
    deleteEverywhere(services, catalog, skillId, groupId),
  );
}

/**
 * All copies go in one transaction, so a failure part-way leaves every copy in place and a retry
 * starts over; folders are only discarded after the commit. Every store involved is held in a
 * fixed order (private first, then groups by id) so two deletes cannot wait on each other, and no
 * write of those stores runs in between.
 */
async function deleteEverywhere(
  services: SkillServices,
  catalog: SkillCatalogRepo,
  skillId: string,
  groupId: string | undefined,
) {
  const found = catalog.copies(skillId, groupId);
  if (!found.copies.length) throw invalid("skill_not_found");
  if (found.builtin) throw invalid("skill_builtin_readonly");
  const scopes = [...new Set(found.copies.map((copy) => copy.groupId ?? ""))].sort();
  const stores = new Map(scopes.map((scope) => [scope, services.skillsFor(scope || undefined)]));
  const run = async () => {
    // Re-read under the locks: a copy given or deleted while waiting is part of this delete.
    const current = catalog.copies(skillId, groupId);
    if (!current.copies.length) throw invalid("skill_not_found");
    if (current.builtin) throw invalid("skill_builtin_readonly");
    if (current.copies.some((copy) => !stores.has(copy.groupId ?? "")))
      throw new RpcError(RpcErrorCodes.connectorStale, "skill_copies_changed");
    const removed = transaction(services.skills.deps.db, () =>
      current.copies.map((copy) => {
        const store = stores.get(copy.groupId ?? "") as SkillService;
        return { store, record: store.removeRow(copy.id) };
      }),
    );
    for (const { store, record } of removed) await store.afterRemove(record);
    return { ok: true as const };
  };
  const locked = [...stores.values()].reduceRight<() => Promise<{ ok: true }>>(
    (inner, store) => () => store.exclusive(inner),
    run,
  );
  return locked();
}

export { SkillCatalogRepo };
