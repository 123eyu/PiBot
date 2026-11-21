import type { CapabilityToolGroup, CapabilityToolSpec } from "@pibot/protocol-base";
import { z } from "zod";

/**
 * Bots can see paired runners; moving a topic onto one needs the user's
 * confirmation on a card. Loaded on demand through tool_discover, so the always-on catalog and
 * its prompt cache do not change.
 */
export const runnerToolGroup = {
  id: "runners",
  description:
    "执行端（已配对的其他电脑）：列出执行端，提议把这个私聊话题的工作文件夹换到执行端上 / Runners (other paired computers): list them, propose moving this DM topic's working folder onto one",
  rule: {
    zh: "执行端是用户配对给这台电脑的其他电脑，Bot 能在它的文件夹里读写文件、跑命令。用户问有哪些电脑或执行端时用 execution_targets 查，不要猜。要换到执行端上干活时用 workplace_use_runner 提议，由用户在卡片上确认；提议后本轮停下来告诉用户，确认后从下一条消息起在新位置工作。执行端离线时如实告诉用户，不要改用这台电脑。",
    en: "Runners are other computers the user paired with this one; Bots can read and write files and run commands in their folders. When the user asks which computers or runners exist, check with execution_targets instead of guessing. To work on a runner, propose it with workplace_use_runner and let the user confirm on the card; after proposing, stop this turn and tell the user — once confirmed, the next message works in the new place. When a runner is offline, say so; never fall back to this computer.",
  },
} as const satisfies CapabilityToolGroup;

export const runnerTools = {
  execution_targets: {
    group: "runners",
    schema: z.strictObject({}),
    description:
      "List the user's paired runners (other computers this one can work on): name, platform, online, whether the current working folder is on it, and the target to pass to workplace_use_runner. No addresses or keys.",
    policy: { category: "workplace_proposal", operation: "list" },
    attributes: { readOnly: true },
  },
  workplace_use_runner: {
    group: "runners",
    schema: z.strictObject({
      target: z.string().regex(/^runner:[a-f0-9]{64}$/),
      path: z.string().trim().min(1).max(32768),
      note: z.string().trim().max(500).optional(),
    }),
    description:
      "Propose moving this DM topic's working folder to an existing folder on a paired runner: target from execution_targets, absolute path on that runner (e.g. C:\\Users\\name\\project), note = why. Only shows the user a card; nothing changes unless they accept, and then from the next message. Not available in groups, routines or subtasks. After calling, stop and tell the user.",
    policy: { category: "workplace_proposal", operation: "propose" },
    attributes: {},
  },
} as const satisfies Record<string, CapabilityToolSpec>;
