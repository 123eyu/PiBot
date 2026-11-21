import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  IdSchema,
  type Page,
  SkillDocumentBaseSchema,
  type SkillDocumentInput,
  type SkillProposal,
  SkillProposalSchema,
  type SkillProposalStatus,
  SkillProposalStatusSchema,
} from "@pibot/skills-contract/full";
import { readPage, transaction } from "@pibot/storage";

const columns = `id,bot_id AS botId,message_id AS messageId,payload,status,
  resolved_skill_id AS resolvedSkillId,created_at AS createdAt,resolved_at AS resolvedAt`;
function parse(row: Record<string, unknown>): SkillProposal {
  return SkillProposalSchema.parse({ ...row, payload: JSON.parse(String(row.payload)) });
}
/** Open proposals per Bot; a model looping on `skill_propose` cannot flood the inbox. */
const MAX_OPEN_PER_BOT = 20;

export class SkillProposalsRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: {
    botId: string;
    messageId: string | null;
    payload: SkillDocumentInput;
  }): SkillProposal {
    const proposal = SkillProposalSchema.parse({
      id: randomUUID(),
      botId: input.botId,
      messageId: input.messageId,
      payload: SkillDocumentBaseSchema.parse(input.payload),
      status: "open",
      resolvedSkillId: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    return transaction(this.db, () => {
      const open = this.db
        .prepare("SELECT COUNT(*) AS n FROM skill_proposals WHERE bot_id=? AND status='open'")
        .get(proposal.botId);
      if (Number(open?.n ?? 0) >= MAX_OPEN_PER_BOT) throw new TypeError("Too many open proposals");
      this.db
        .prepare(`INSERT INTO skill_proposals(id,bot_id,message_id,payload,status,resolved_skill_id,
          created_at,resolved_at) VALUES (?,?,?,?,'open',NULL,?,NULL)`)
        .run(
          proposal.id,
          proposal.botId,
          proposal.messageId,
          JSON.stringify(proposal.payload),
          proposal.createdAt,
        );
      return proposal;
    });
  }

  get(id: string): SkillProposal | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM skill_proposals WHERE id=?`)
      .get(IdSchema.parse(id));
    return row ? parse(row) : undefined;
  }

  list(
    query: { botId?: string; messageId?: string; status?: SkillProposalStatus } = {},
    page: Page = {},
  ): SkillProposal[] {
    const scope: [string, string][] = [];
    if (query.botId) scope.push(["bot_id", IdSchema.parse(query.botId)]);
    if (query.messageId) scope.push(["message_id", IdSchema.parse(query.messageId)]);
    const filters = [...scope];
    if (query.status) filters.push(["status", SkillProposalStatusSchema.parse(query.status)]);
    return readPage(this.db, "skill_proposals", columns, "created_at", page, filters, scope).map(
      parse,
    );
  }

  /**
   * Closes an open proposal exactly once. Brain creates the skill in the same outer transaction
   * and passes its ID; a second resolve (double click, two windows) fails instead of duplicating.
   */
  resolve(
    id: string,
    outcome: { status: "accepted"; skillId: string } | { status: "declined" | "expired" },
  ): SkillProposal {
    return transaction(this.db, () => {
      const skillId = outcome.status === "accepted" ? IdSchema.parse(outcome.skillId) : null;
      const changed = this.db
        .prepare(`UPDATE skill_proposals SET status=?,resolved_skill_id=?,resolved_at=?
          WHERE id=? AND status='open'`)
        .run(outcome.status, skillId, new Date().toISOString(), IdSchema.parse(id)).changes;
      if (!changed) throw new TypeError("Proposal is not open");
      return this.get(id) as SkillProposal;
    });
  }
}
