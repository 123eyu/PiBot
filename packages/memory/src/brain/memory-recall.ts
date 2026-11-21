import type { DatabaseSync } from "node:sqlite";
import type { BrainRedactor, MemoryPromptRequest } from "@pibot/brain/kit";
import type { Memory, MemoryOwner } from "@pibot/protocol-base";
import { MemoriesRepo, memoryCatalogRows, recallMemoryIds } from "@pibot/storage";

export const MEMORY_RECALL_TOKENS = 2000;
// The catalog is a fixed, small part of the prompt; it keeps the note ids addressable.
export const MEMORY_CATALOG_TOKENS = 1500;
const MEMORY_CATALOG_ROWS = 320;
// Per non-user scope: below this, every active note is injected instead of recalled by keywords.
export const SMALL_SCOPE_TOKENS = 500;
/**
 * Maintainers 2026-11-11: user notes reach every Bot, and 46 of them (52 with Bot notes) were injected
 * in full on every turn. They now get a fixed budget; the rest stay in the catalog and recall.
 */
export const USER_RESIDENT_TOKENS = 800;
const byId = (a: Memory, b: Memory) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Oldest first: an established note is not displaced by a newer one, and nothing that changes per
// turn (use counts, last use) takes part, so the resident set only moves when the notes do.
const byCreation = (a: Memory, b: Memory) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : byId(a, b);
const noteText = ({ id, text, category }: Memory) => ({ id, text, category });

// Same conservative heuristic as the agent's text budget: ASCII/4, non-ASCII per code unit.
// No provider tokenizer or model request is needed; usage timestamps never affect the result.
function tokens(text: string) {
  let value = 0;
  for (const point of text) value += (point.codePointAt(0) ?? 0) > 127 ? point.length : 0.25;
  return Math.ceil(value);
}

export function selectMemory(
  db: DatabaseSync,
  redactor: BrainRedactor,
  botId: string,
  owners: readonly MemoryOwner[],
  request?: MemoryPromptRequest,
) {
  request?.signal.throwIfAborted();
  const repos = new Map(
    owners.map((owner) => [
      `${owner.scope}:${owner.ownerId}`,
      new MemoriesRepo(db, (text) => redactor.redact(text), owner),
    ]),
  );
  const resident: Memory[] = [];
  for (const [key, repo] of repos) {
    const candidates: Memory[] = [];
    let before: string | undefined;
    for (;;) {
      request?.signal.throwIfAborted();
      const page = repo.residentPage(botId, { limit: 100, ...(before ? { before } : {}) });
      candidates.push(...page);
      if (page.length < 100) break;
      before = page.at(-1)?.id;
    }
    if (!key.startsWith("user:")) {
      resident.push(...candidates);
      continue;
    }
    let remaining = USER_RESIDENT_TOKENS;
    for (const note of candidates.sort(byCreation)) {
      const cost = tokens(redactor.redact(JSON.stringify(noteText(note)))) + 1;
      // A long note that does not fit is skipped, not a stop: later short notes still fit, and the
      // skipped one remains reachable through the catalog, recall and memory_read.
      if (cost > remaining) continue;
      resident.push(note);
      remaining -= cost;
    }
  }
  // Keyword recall misses paraphrases (about 60% on tools/probes/memory/recall-zh.ts),
  // so a scope whose remaining active notes are small enough is kept whole; only larger scopes
  // fall back to recall. The per-scope cap bounds the extra prompt.
  const residentIds = new Set(resident.map((note) => note.id));
  for (const [key, repo] of repos) {
    if (key.startsWith("user:")) continue;
    const rest: Memory[] = [];
    let total = 0;
    let before: string | undefined;
    scan: for (;;) {
      request?.signal.throwIfAborted();
      const page = repo.page(botId, { limit: 100, ...(before ? { before } : {}) }, "active");
      for (const note of page) {
        if (residentIds.has(note.id)) continue;
        total += tokens(redactor.redact(recalledMemoryText([note]))) + 1;
        if (total > SMALL_SCOPE_TOKENS) {
          rest.length = 0;
          break scan;
        }
        rest.push(note);
      }
      if (page.length < 100) break;
      before = page.at(-1)?.id;
    }
    for (const note of rest) residentIds.add(note.id);
    resident.push(...rest);
  }
  const recalled: Memory[] = [];
  // Reserve room for section labels, owner labels and JSON separators inside the shared budget.
  let remaining = MEMORY_RECALL_TOKENS - 100;
  for (const candidate of recallMemoryIds(db, owners, request?.query ?? "", request?.signal, [
    ...residentIds,
  ])) {
    request?.signal.throwIfAborted();
    if (residentIds.has(candidate.id)) continue;
    const note = repos.get(`${candidate.scope}:${candidate.ownerId}`)?.get(botId, candidate.id);
    if (!note) continue;
    const cost = tokens(redactor.redact(recalledMemoryText([note]))) + 1;
    if (cost > remaining) continue;
    recalled.push(note);
    remaining -= cost;
  }
  request?.signal.throwIfAborted();
  return { resident: resident.sort(byId), recalled: recalled.sort(byId) };
}

export function recalledMemoryText(notes: readonly Memory[]) {
  return JSON.stringify(notes.map((note) => ({ scope: note.scope, ...noteText(note) })));
}

/**
 * One stable line per visible active note. Only ids and a short preview are injected, so
 * the model knows what exists without paying for every full text; why/how stay out on purpose.
 */
export function memoryCatalog(
  db: DatabaseSync,
  owners: readonly MemoryOwner[],
  shown: readonly string[] = [],
) {
  const { rows, total } = memoryCatalogRows(db, owners, MEMORY_CATALOG_ROWS, shown);
  const lines: string[] = [];
  let budget = MEMORY_CATALOG_TOKENS;
  for (const row of rows) {
    const line = `- ${row.id} [${row.scope}${row.category ? `/${row.category}` : ""}] ${row.preview}`;
    // One token per line covers the newline the joined block adds.
    const cost = tokens(line) + 1;
    if (cost > budget) break;
    lines.push(line);
    budget -= cost;
  }
  if (!lines.length) return "";
  const hidden = total - lines.length;
  return [
    "Memory catalog / 记忆目录（id、范围/类别、前 60 字，仅为截断摘要，不是全文）/ Truncated previews only, not full notes:\n回答涉及记忆中的具体数字、名字或步骤时，先用对应 id 调用 memory_read 核对原文（含「为什么/怎么用」），不要从目录摘要推断或补全；目录里找不到时先用 memory_search 查，再读匹配项。/ Before answering with specific numbers, names or steps from memory, call memory_read with the matching id to verify the full note (including why/how). Do not infer or fill in details from catalog previews. If no entry matches, use memory_search, then read the matching note.",
    ...lines,
    ...(hidden > 0
      ? [
          `还有 ${hidden} 条未列出，用 memory_search 查 / ${hidden} more not listed; search with memory_search(query).`,
        ]
      : []),
  ].join("\n");
}

export function memorySections(notes: readonly Memory[], owners: readonly MemoryOwner[]) {
  return owners
    .flatMap((owner) => {
      const values = notes.filter(
        (note) => note.scope === owner.scope && note.ownerId === owner.ownerId,
      );
      return values.length ? [`${owner.scope}:\n${JSON.stringify(values.map(noteText))}`] : [];
    })
    .join("\n\n");
}
