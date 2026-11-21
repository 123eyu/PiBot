import {
  EndpointCapabilityRowSchema,
  EndpointKindSchema,
  EndpointScopeSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

export const EndpointMethods = {
  "endpoints.list": {
    params: z.strictObject({
      after: z.string().max(200).optional(),
      endpointId: EndpointCapabilityRowSchema.shape.endpointId.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    result: z.strictObject({
      items: z.array(
        EndpointCapabilityRowSchema.extend({
          online: z.boolean(),
          endpointKind: EndpointKindSchema,
          endpointName: z.strictObject({ zh: z.string(), en: z.string() }),
          name: z.strictObject({ zh: z.string(), en: z.string() }),
        }),
      ),
      nextAfter: z.string().nullable(),
    }),
  },
  "endpoints.capability.set": {
    params: z.strictObject({
      endpointId: EndpointCapabilityRowSchema.shape.endpointId,
      capabilityId: EndpointCapabilityRowSchema.shape.capabilityId,
      enabled: z.boolean(),
      scope: EndpointScopeSchema,
      // Compared in the write transaction; required on the phone gateway.
      expected: EndpointCapabilityRowSchema.pick({
        version: true,
        state: true,
        scope: true,
      }).optional(),
    }),
    result: EndpointCapabilityRowSchema,
  },
} as const;
export const EndpointEvents = { "endpoints.changed": z.strictObject({}) } as const;
