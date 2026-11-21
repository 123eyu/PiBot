import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type Bot,
  canonicalImageModelId,
  type ImageModelInfo,
  type ModelInfo,
  resolveThinkingLevel,
  TEAM_V3_JSON_MAX_BYTES,
  type TeamPreview,
  TeamPreviewSchema,
  type TeamTemplate,
  TeamTemplateSchema,
} from "@pibot/protocol";
import {
  BotsRepo,
  GroupsRepo,
  GroupVerificationRulesRepo,
  SidebarRepo,
  transaction,
} from "@pibot/storage";

export function parseTeamFile(text: string): TeamTemplate {
  // The schema applies the per-version limit (1 MB for JSON files, 4 MB for a v3 team.json).
  if (new TextEncoder().encode(text).byteLength > TEAM_V3_JSON_MAX_BYTES)
    throw new TypeError("Team exceeds its size limit");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("Invalid team file");
  }
  return TeamTemplateSchema.parse(value);
}
export class TeamsRepo {
  private readonly previews = new Map<string, TeamPreview>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly redact: (text: string) => string,
  ) {}
  /**
   * `version: 3` adds each Bot's role mark, norms and quick prompts; skills are added by
   * brain, which also decides the final version.
   */
  export(input: { botIds?: string[]; groupId?: string }, version: 1 | 3 = 1): TeamTemplate {
    if (!!input.botIds === !!input.groupId) throw new TypeError("Select Bots or group");
    const group = input.groupId ? new GroupsRepo(this.db).get(input.groupId) : undefined;
    if (input.groupId && !group) throw new TypeError("Unknown group");
    const ids = group ? group.members.map((m) => m.botId) : (input.botIds ?? []),
      repo = new BotsRepo(this.db);
    return TeamTemplateSchema.parse({
      format: "pibot-team",
      version,
      bots: ids.map((id) => {
        const b = repo.get(id);
        if (!b || b.archivedAt) throw new TypeError("Unknown active Bot");
        return {
          ref: id,
          name: b.name,
          category: b.category,
          imageMode: b.imageMode,
          description: this.redact(b.description ?? ""),
          systemPrompt: this.redact(b.systemPrompt),
          avatarShape: b.avatarShape,
          avatarColor: b.avatarColor,
          avatarEyes: b.avatarEyes,
          ...(version === 3 && b.avatarImage ? { avatarImage: b.avatarImage } : {}),
          model: b.modelProvider && b.modelId ? { provider: b.modelProvider, id: b.modelId } : null,
          thinkingLevel: b.thinkingLevel,
          thinkingPreference: b.thinkingPreference,
          permissionOverrides: b.permissionOverrides ?? {},
          ...(version === 3 && b.role ? { role: b.role } : {}),
          ...(version === 3 && b.norms ? { norms: this.redact(b.norms) } : {}),
          ...(version === 3 && b.quickPrompts?.length
            ? { quickPrompts: b.quickPrompts.map((p) => this.redact(p)) }
            : {}),
        };
      }),
      groups: group
        ? [
            {
              name: group.name,
              members: ids,
              coordinator: group.coordinatorBotId,
              announcement: this.redact(group.announcement),
              autoRoundLimit: group.autoRoundLimit,
              // Written only when the group has rules: older Pi Bot versions read this file
              // strictly and would refuse an unknown (even empty) field.
              ...(() => {
                const verification =
                  version === 3 ? new GroupVerificationRulesRepo(this.db).get(group.id) : {};
                return Object.keys(verification).length ? { verification } : {};
              })(),
            },
          ]
        : [],
    });
  }
  preview(
    text: string,
    models: (Pick<ModelInfo, "provider" | "id"> &
      Partial<Pick<ModelInfo, "reasoning" | "thinkingLevels">>)[],
    fallback: { provider: string; id: string; thinkingLevel?: Bot["thinkingLevel"] } | null,
    now = new Date(),
    imageModels: Pick<ImageModelInfo, "provider" | "id" | "modes">[] = [],
  ): TeamPreview {
    for (const [id, p] of this.previews)
      if (Date.parse(p.expiresAt) <= now.getTime()) this.previews.delete(id);
    if (this.previews.size >= 32) throw new TypeError("Too many team previews");
    const template = parseTeamFile(text);
    const modelKey = (model: Pick<ModelInfo, "provider" | "id">) =>
      JSON.stringify([model.provider, model.id]);
    const availableModels = new Map(models.map((model) => [modelKey(model), model]));
    const preview = TeamPreviewSchema.parse({
      previewId: randomUUID(),
      template,
      models: template.bots.map((b) => {
        const available =
          !!b.model &&
          (b.category === "image"
            ? imageModels.some(
                (m) =>
                  m.provider === b.model?.provider &&
                  m.id === canonicalImageModelId(b.model.provider, b.model.id) &&
                  m.modes.length > 0,
              )
            : availableModels.has(modelKey(b.model)));
        const resolved = available
          ? b.model
          : b.category === "image"
            ? null
            : fallback
              ? { provider: fallback.provider, id: fallback.id }
              : null;
        const model = resolved ? availableModels.get(modelKey(resolved)) : undefined;
        const preference =
          b.thinkingPreference === undefined ? b.thinkingLevel : b.thinkingPreference;
        return {
          ref: b.ref,
          preferred: b.model,
          resolved,
          available,
          thinkingLevel:
            b.category === "image" || !resolved
              ? "off"
              : resolveThinkingLevel(
                  { reasoning: model?.reasoning ?? true, thinkingLevels: model?.thinkingLevels },
                  preference,
                ),
        };
      }),
      expiresAt: new Date(now.getTime() + 300000).toISOString(),
    });
    this.previews.set(preview.previewId, structuredClone(preview));
    return preview;
  }
  /** A live preview, for reading what the user is reviewing (never for importing). */
  get(previewId: string, now = new Date()): TeamPreview | undefined {
    const preview = this.previews.get(previewId);
    return preview && Date.parse(preview.expiresAt) > now.getTime() ? preview : undefined;
  }
  dismiss(previewId: string): void {
    this.previews.delete(previewId);
  }
  importPreview(
    previewId: string,
    sidebarName: string,
    now = new Date(),
    imageModels: Pick<ImageModelInfo, "provider" | "id" | "modes">[] = [],
  ): { botIds: string[]; groupIds: string[]; sidebarGroupId: string } {
    const p = this.previews.get(previewId);
    if (!p || Date.parse(p.expiresAt) <= now.getTime()) {
      this.previews.delete(previewId);
      throw new TypeError("Unknown or expired preview");
    }
    for (const b of p.template.bots) {
      if (
        b.category === "image" &&
        (!b.model ||
          !b.imageMode ||
          !imageModels.some(
            (m) =>
              m.provider === b.model?.provider &&
              m.id === canonicalImageModelId(b.model.provider, b.model.id) &&
              m.modes.length > 0,
          ))
      )
        throw new TypeError("image_model_unavailable");
    }
    // Import exactly the model mapping the user reviewed, never a later renderer-supplied template.
    const mappings = new Map(p.models.map((model) => [model.ref, model]));
    const mapped = {
      ...p.template,
      bots: p.template.bots.map((b) => ({
        ...b,
        model: mappings.get(b.ref)?.resolved ?? null,
        thinkingPreference:
          b.thinkingPreference === undefined ? b.thinkingLevel : b.thinkingPreference,
        thinkingLevel: mappings.get(b.ref)?.thinkingLevel ?? "off",
      })),
    };
    const models = p.models.flatMap((m) => (m.resolved ? [m.resolved] : []));
    const result = this.import(mapped, models, null, sidebarName);
    this.previews.delete(previewId);
    return result;
  }
  dispose(): void {
    this.previews.clear();
  }
  import(
    template: TeamTemplate,
    models: Pick<ModelInfo, "provider" | "id">[],
    fallback: { provider: string; id: string } | null,
    sidebarName: string,
  ): { botIds: string[]; groupIds: string[]; sidebarGroupId: string } {
    const t = TeamTemplateSchema.parse(template);
    return transaction(this.db, () => {
      const bots = new BotsRepo(this.db),
        groups = new GroupsRepo(this.db),
        sidebar = new SidebarRepo(this.db),
        refs = new Map<string, string>();
      const section = sidebar.createGroup(sidebarName),
        existing = new Set(
          this.db
            .prepare("SELECT name FROM bots")
            .all()
            .map((r) => String(r.name)),
        );
      for (const b of t.bots) {
        let name = b.name,
          n = 2;
        while (existing.has(name)) {
          const suffix = ` (${n++})`;
          name = `${b.name.slice(0, 200 - suffix.length)}${suffix}`;
        }
        existing.add(name);
        const model =
          b.model && models.some((m) => m.provider === b.model?.provider && m.id === b.model.id)
            ? b.model
            : b.category === "image"
              ? null
              : fallback;
        const bot = bots.create({
          name,
          category: b.category,
          imageMode: b.imageMode,
          isMain: false,
          description: this.redact(b.description),
          systemPrompt: this.redact(b.systemPrompt),
          avatarShape: b.avatarShape,
          avatarColor: b.avatarColor,
          avatarEyes: b.avatarEyes,
          ...(b.avatarImage ? { avatarImage: b.avatarImage } : {}),
          modelProvider: model?.provider ?? null,
          modelId: model?.id ?? null,
          thinkingLevel: b.category === "image" ? "off" : b.thinkingLevel,
          thinkingPreference: b.category === "image" ? "off" : b.thinkingPreference,
          memoryMode: "auto",
          permissionOverrides: b.permissionOverrides,
          // The role is only a mark of origin; norms and starters are plain Bot text.
          ...(b.role ? { role: b.role } : {}),
          ...(b.norms ? { norms: this.redact(b.norms) } : {}),
          ...(b.quickPrompts?.length
            ? { quickPrompts: b.quickPrompts.map((p) => this.redact(p)) }
            : {}),
        });
        refs.set(b.ref, bot.id);
        sidebar.update(`dm:${bot.id}`, { groupId: section.id });
      }
      const groupIds = t.groups.map((g) => {
        let name = g.name,
          n = 2;
        const names = new Set(
          this.db
            .prepare("SELECT name FROM groups")
            .all()
            .map((r) => String(r.name)),
        );
        while (names.has(name)) {
          const suffix = ` (${n++})`;
          name = `${g.name.slice(0, 200 - suffix.length)}${suffix}`;
        }
        const value = groups.create({
          name,
          botIds: g.members.map((ref) => refs.get(ref) as string),
          coordinatorBotId: refs.get(g.coordinator),
          announcement: this.redact(g.announcement),
          autoRoundLimit: g.autoRoundLimit,
        });
        if (g.verification) new GroupVerificationRulesRepo(this.db).set(value.id, g.verification);
        sidebar.update(`group:${value.id}`, { groupId: section.id });
        return value.id;
      });
      return { botIds: [...refs.values()], groupIds, sidebarGroupId: section.id };
    });
  }
}
