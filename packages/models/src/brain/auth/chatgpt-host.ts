import { randomUUID } from "node:crypto";
import { CHATGPT_PLAN_PROVIDER } from "@pibot/models-contract/full";
import { z } from "zod";
import type { ProvidersRepo } from "../../store/index.ts";

/** This opaque host identity lives with the installation, separately from rotating credentials. */
export function chatgptHostId(repo: ProvidersRepo): string {
  const row = repo.get(CHATGPT_PLAN_PROVIDER);
  const saved = z.uuid().optional().parse(row?.config.chatgptHostId);
  if (saved) return saved;
  const id = randomUUID();
  repo.upsert({
    id: CHATGPT_PLAN_PROVIDER,
    kind: "builtin",
    config: { ...row?.config, chatgptHostId: id },
  });
  return id;
}
