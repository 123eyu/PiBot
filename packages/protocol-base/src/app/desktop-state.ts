import { z } from "zod";

// Own module: the GUI reads it before the window exists, ahead of the protocol schemas.
export const DesktopStateSchema = z.strictObject({
  bounds: z.strictObject({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: z.number().finite().min(960),
    height: z.number().finite().min(640),
  }),
  closeToTrayHintShown: z.boolean(),
  // A bounds-only cache written before database settings arrive has no login preference yet.
  openAtLogin: z.boolean().optional(),
});
