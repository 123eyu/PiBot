import { z } from "zod";
import { MemoryProposalSchema, MemorySchema } from "../bots/memory.ts";
import { IdSchema } from "../core/ids.ts";

const group = z.strictObject({ groupId: IdSchema });
const ok = z.strictObject({ ok: z.literal(true) });
export const GroupResourceMethods = {
  "groups.memory.list": {
    params: group,
    result: z.strictObject({
      memories: z.array(MemorySchema).max(100),
      proposals: z.array(MemoryProposalSchema).max(100),
    }),
  },
  "groups.memory.save": {
    params: group.extend({
      id: IdSchema.optional(),
      expectedUpdatedAt: z.iso.datetime().optional(),
      text: MemorySchema.shape.text,
      category: MemorySchema.shape.category,
    }),
    result: MemorySchema,
  },
  "groups.memory.remove": {
    params: group.extend({ id: IdSchema, confirmed: z.literal(true) }),
    result: ok,
  },
  "groups.memory.resolve": {
    params: group.extend({ proposalId: IdSchema, accept: z.boolean() }),
    result: z.strictObject({ proposal: MemoryProposalSchema, memory: MemorySchema.nullable() }),
  },
} as const;
export const GroupResourceEvents = {
  "groups.resources.changed": group.extend({
    kind: z.enum(["memory", "skills"]),
    needsOrganization: z.boolean().optional(),
  }),
} as const;
