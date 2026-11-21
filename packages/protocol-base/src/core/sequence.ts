import { z } from "zod";

const count = z.number().int().nonnegative().safe();
export const SequenceSchema = count;
