import type { ManagedResourceKey } from "@pibot/i18n";
import type {
  ChangesMethods,
  EventPayloads,
  FileCheckpointMethods,
  GroupTopicMethods,
  ManagedWorktreeMethods,
} from "@pibot/workspaces-contract/full";
import type { z } from "zod";

type Definitions = typeof ManagedWorktreeMethods &
  typeof ChangesMethods &
  typeof FileCheckpointMethods &
  typeof GroupTopicMethods;
export interface ManagedResourcesApi {
  on?(
    method: "changes.changed",
    listener: (event: EventPayloads["changes.changed"]) => void,
  ): () => void;
  call<K extends keyof Definitions>(
    method: K,
    params: z.input<Definitions[K]["params"]>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<z.output<Definitions[K]["result"]>>;
}
export type ManagedResourceTranslate = (key: ManagedResourceKey) => string;
