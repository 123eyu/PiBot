import type { DatabaseSync } from "node:sqlite";
import { type SkillDocument, SkillDocumentSchema } from "@pibot/skills-contract/full";
import { type SkillUpdateScope, updateKey } from "./skill-updates.ts";

const MetadataSchema = SkillDocumentSchema.omit({ name: true, description: true, body: true });

/** Metadata belongs to a scoped reference, never to every user of the same content hash. */
export class SkillDocumentMetadataRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(scope: SkillUpdateScope, id: string, packageId?: string) {
    const row = this.db
      .prepare("SELECT document FROM skill_document_metadata WHERE owner=? AND package_id=?")
      .get(updateKey(scope, id), packageId ?? "");
    if (!row) return undefined;
    // Unlike an absent legacy record, corrupt app metadata must not revive a source's fields.
    let value: unknown;
    try {
      value = JSON.parse(String(row.document));
    } catch {
      throw new Error("skill_metadata_invalid");
    }
    const parsed = MetadataSchema.safeParse(value);
    if (!parsed.success) throw new Error("skill_metadata_invalid");
    return parsed.data;
  }

  put(scope: SkillUpdateScope, id: string, packageId: string | undefined, document: SkillDocument) {
    const { name: _name, description: _description, body: _body, ...metadata } = document;
    this.db
      .prepare(
        `INSERT INTO skill_document_metadata(owner,package_id,document) VALUES(?,?,?)
       ON CONFLICT(owner,package_id) DO UPDATE SET document=excluded.document`,
      )
      .run(updateKey(scope, id), packageId ?? "", JSON.stringify(MetadataSchema.parse(metadata)));
  }
}
