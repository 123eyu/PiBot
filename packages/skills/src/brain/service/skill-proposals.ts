import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import type { SkillProposalContext } from "@pibot/brain/kit";
import { redactValue } from "@pibot/brain/kit";
import {
  type MethodParams,
  type MethodResults,
  RpcError,
  type SkillProposal,
  SkillProposeInputSchema,
} from "@pibot/skills-contract/full";
import { MessagesRepo, transaction } from "@pibot/storage";
import { SkillProposalsRepo } from "../../store/index.ts";
import type { SkillService } from "./skill-service.ts";

const invalid = (message: string) => new RpcError(-32602, message);

/**
 * `skill_propose`: the Bot only creates a confirmation card; the skill is saved when the
 * user accepts it in chat, exactly once, with any edits they made on the card.
 */
export class SkillProposals {
  readonly repo: SkillProposalsRepo;
  constructor(private readonly skills: SkillService) {
    this.repo = new SkillProposalsRepo(skills.deps.db);
  }
  list(query: MethodParams["skills.proposals"]): SkillProposal[] {
    const { id, botId, messageId, ...page } = query;
    if (id) {
      const p = this.repo.get(id);
      return p && (!botId || p.botId === botId) && (!messageId || p.messageId === messageId)
        ? [p]
        : [];
    }
    return this.repo.list({ botId, messageId }, page);
  }
  async propose(
    context: SkillProposalContext,
    call: LocalToolCall,
    automatic?: { assertCurrent(): void; audit(): void },
    onPending?: (
      accept: (confirmation: { assertCurrent(): void; audit(): void }) => Promise<void>,
    ) => void,
  ): Promise<LocalToolResult> {
    const zh = context.language === "zh";
    this.skills.activeBot(context.botId);
    const message = new MessagesRepo(this.skills.deps.db).get(context.messageId);
    if (
      message?.botId !== context.botId ||
      message.runId !== context.runId ||
      message.role !== "assistant" ||
      message.status !== "streaming"
    )
      throw invalid("skill_proposal_unavailable");
    const input = SkillProposeInputSchema.safeParse(
      redactValue(call.input, this.skills.deps.redactor),
    );
    if (!input.success)
      return {
        isError: true,
        text: zh
          ? "技能参数无效：name ≤80 字、description 单行 ≤1024 字、body 非空，params 最多 20 个且不重名。请修正后重试。"
          : "Invalid skill: name ≤80 characters, description one line ≤1024 characters, non-empty body, at most 20 uniquely named params. Correct it and retry.",
      };
    if (this.skills.repo.findByName(context.botId, input.data.name))
      return {
        isError: true,
        text: zh
          ? "已经有同名技能。换一个名字，或请用户在资料面板里编辑原来的技能。"
          : "A skill with this name already exists. Choose another name, or ask the user to edit the existing skill in the profile panel.",
      };
    if (automatic) {
      const skill = await this.skills.create(context.botId, input.data, "proposed", {
        reason: "accepted",
        assertCurrent: automatic.assertCurrent,
        afterInsert: () => automatic.audit(),
        automatic: {
          runId: context.runId,
          toolCallId: call.id,
          conversationId: context.conversationId,
        },
      });
      return {
        text: JSON.stringify({ saved: true, skillId: skill.id }),
        summary: zh ? "技能已保存（YOLO）" : "Skill saved (YOLO)",
      };
    }
    let proposal: SkillProposal;
    try {
      proposal = transaction(this.skills.deps.db, () => {
        const created = this.repo.create({
          botId: context.botId,
          messageId: context.messageId,
          payload: input.data,
        });
        this.skills.audit(context.botId, input.data.name, "proposed", context.runId);
        return created;
      });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return {
        isError: true,
        text: zh
          ? "待确认的技能提议太多，请等用户处理完再提。"
          : "Too many skill proposals are waiting; wait for the user to handle them first.",
      };
    }
    this.changed(proposal);
    onPending?.(async (confirmation) => {
      if (this.repo.get(proposal.id)?.status !== "open") return;
      await this.skills.create(context.botId, input.data, "proposed", {
        reason: "accepted",
        assertCurrent: confirmation.assertCurrent,
        automatic: {
          runId: context.runId,
          toolCallId: call.id,
          conversationId: context.conversationId,
        },
        afterInsert: (record) => {
          this.repo.resolve(proposal.id, { status: "accepted", skillId: record.id });
          confirmation.audit();
        },
      });
      this.changed(this.repo.get(proposal.id) ?? proposal);
    });
    return {
      text: zh
        ? "已在聊天里给用户一张确认卡。用户确认后技能才会保存；在那之前不要说已经存好。"
        : "A confirmation card is shown to the user. The skill is saved only after they confirm; do not say it is saved before that.",
      summary: zh
        ? `提议存成技能「${input.data.name}」`
        : `Proposed saving skill "${input.data.name}"`,
    };
  }
  async resolve(
    params: MethodParams["skills.propose.resolve"],
  ): Promise<MethodResults["skills.propose.resolve"]> {
    const p = this.repo.get(params.proposalId);
    if (!p) throw invalid("skill_proposal_unavailable");
    if (p.status !== "open") throw invalid("skill_proposal_closed");
    if (!params.accept) {
      const proposal = transaction(this.skills.deps.db, () => {
        const result = this.repo.resolve(p.id, { status: "declined" });
        this.skills.audit(p.botId, p.payload.name, "declined");
        return result;
      });
      this.changed(proposal);
      return { proposal, skill: null };
    }
    let skill: MethodResults["skills.propose.resolve"]["skill"];
    try {
      const { contract, ...edits } = params.edits ?? {};
      // Proposal cards edit ordinary skills; workflow contracts only enter through the editor RPC.
      if (contract !== undefined) throw invalid("workflow_contract_edit_unsupported");
      skill = await this.skills.create(p.botId, { ...p.payload, ...edits }, "proposed", {
        reason: "accepted",
        fileChanges: params.files,
        afterInsert: (record) =>
          this.repo.resolve(p.id, { status: "accepted", skillId: record.id }),
      });
    } catch (error) {
      if (error instanceof TypeError && error.message === "Proposal is not open")
        throw invalid("skill_proposal_closed");
      throw error;
    }
    const proposal = this.repo.get(p.id) ?? p;
    this.changed(proposal);
    return { proposal, skill };
  }
  private changed(p: SkillProposal) {
    this.skills.changed(p.botId, p.status === "open" ? "proposed" : "resolved", undefined, {
      proposalId: p.id,
      ...(p.messageId ? { messageId: p.messageId } : {}),
    });
  }
}
