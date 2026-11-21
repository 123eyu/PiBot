import { toolLoadGroup as resolveToolLoadGroup } from "../../packages/brain/src/runtime/tools/tool-catalog.ts";
import { productCapabilityTools } from "../../packages/brain-app/src/index.ts";

/** Test composition uses brain-app's product registry instead of a kernel-global capability list. */
export const toolLoadGroup = (name: string) => resolveToolLoadGroup(name, productCapabilityTools);
