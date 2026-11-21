import type { CapabilityToolGroup, CapabilityToolSpec } from "@pibot/protocol-base";
import { z } from "zod";
import { RoutineProposeInputSchema } from "../proposals/propose.ts";
import { RoutineQueryInputSchema } from "../views/query.ts";

export const routineToolGroup = {
  id: "routines",
  description:
    "例行任务：查询与定时/目录监视提案 / Query routines, propose schedules or folder watches",
  rule: {
    zh: "仅用户要求定期任务时用routine_propose；修改先routine_query分页查真实ID，重名按时间/说明请用户选，不猜ID或改成新建。提案前核对工作目录、命令/脚本、读写路径、联网域名、连接和凭据是否可用；信息不足说明待确认，不猜测。根据明确需求填有界preauth候选，用户确认卡后才生效。主动说明卡内可选「试运行一次」：用户点击才真实执行，通过审批发现所需权限，结束后可将有效操作加入预授权再保存；试运行会真实写入或发送，不能称为无副作用检查。命令联网名单在设置›权限›联网或Bot的权限页，用户明确添加的域名才用于自动命令；网站访问预授权不等于脚本联网权限。secret请用户在连接›访问令牌配置，不索取原文。未知脚本、危险操作和沙箱外执行不能保证记住，说明可能暂停等授权；不擅自启用YOLO或绕过沙箱。等用户在卡上确认，Bot/群消息不能代确认；监视目录只读，输出写主文件夹。",
    en: "Use routine_propose only for user-requested recurring work. Query actual IDs before updates; resolve duplicates with the user, never guess or create a replacement. Before proposing, check the workplace, commands/scripts, read/write paths, network domains, connections and credentials; explain unknowns. Include bounded preauth candidates only from explicit needs, effective after user confirmation. Offer the card's optional Try once: only a user click starts real work under normal approvals, then eligible operations can be added to preauthorization before saving. A trial may really write or send; never describe it as side-effect-free. Command domains are configured in Settings > Permissions > Network or the Bot's permissions; only explicitly added domains extend automatic commands. Website preauthorization does not grant script network access. Ask users to configure secrets in Connections > Access tokens, never paste values. Opaque scripts, dangerous actions and outside-sandbox execution may still pause for approval; never promise they are remembered, enable YOLO or bypass isolation. Await the user's card confirmation, never Bot/group approval. Monitored folders stay readonly; output goes to the primary folder.",
  },
} as const satisfies CapabilityToolGroup;

/** The routines tools; the brain entry registers their executors (`proposals/service.ts`). */
export const routineTools = {
  routine_propose: {
    group: "routines",
    schema: RoutineProposeInputSchema,
    description:
      "Propose user-requested schedules only. kind=once: localTime YYYY-MM-DDTHH:mm:ss[.sss] + optional IANA timezone (default system), OR UTC at YYYY-MM-DDTHH:mm:ss.sssZ; no cron/folder. DST repeats need user’s earlier/later choice; nonexistent times need card correction. Updates require routine_query, user-resolved duplicates and routineId; omitting ID creates NEW work, never an update fallback. Omit uncertain fields; list missingFields. Folder paths must be absolute; readonly folders stay readonly. Cron: five fields, minimum 5 minutes (dev 1); use specified IANA timezone, otherwise omit for new cron without asking, preserve queried timezone on updates. Check sandbox needs first (cwd, scripts, read/write paths, explicit command domains, connections and credentials). Offer the user the card's optional Try once; it performs real work under approvals and its eligible operations can be explicitly added to preauthorization, then saved. Never execute a trial on the user's behalf or promise no side effects. Include bounded preauth candidates from explicit instructions; never invent scopes or claim opaque scripts/dynamic commands can be remembered. Website scopes do not authorize script networking; users add command domains in Permissions > Network. Secrets belong in Connections > Access tokens. Normally await user’s card, never Bot approval. Complete valid YOLO requests save immediately without new preauthorization/folder registration; missing details/new grants fail. Only saved receipts prove creation.",
    policy: { category: "routine_proposal", operation: "propose" },
    attributes: { readOnly: false, output: "message" },
  },
  routine_query: {
    group: "routines",
    schema: RoutineQueryInputSchema,
    description:
      "Readonly paginated routine lookup. Before updates query exact name or browse for its ID; never guess/replace. selectionRequired means duplicate names: user chooses by schedule/description. Keep IDs internal. No execution/proposals/permission changes.",
    policy: { category: "routine_proposal", operation: "query" },
    attributes: { readOnly: true },
  },
  routine_flag_attention: {
    schema: z.strictObject({ reason: z.string().trim().min(1).max(200) }),
    description:
      "Scheduled runs only: mark this run's result as needing the user (a decision, a confirmation, an error or anything they must look at), with a one-sentence reason. Tasks set to notify only when attention is needed notify only after this mark. Call it once; it changes no settings and grants nothing.",
    // Bookkeeping on the run itself: no file, command or network access.
    policy: { category: "planning" },
    attributes: { readOnly: true },
    unattendedOnly: true,
    rule: {
      zh: "这是调度任务的自动运行，没有人在看。结果需要用户处理（要做决定、要确认、出了异常或必须看）时，调用 routine_flag_attention 写明原因；不要只在回复里提问。",
      en: "This is an unattended scheduled run. When the result needs the user (a decision, a confirmation, an error, something they must see), call routine_flag_attention with the reason; do not only ask in your reply.",
    },
  },
} as const satisfies Record<string, CapabilityToolSpec>;
