import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { type ImageContent, ImageContentSchema } from "@pibot/protocol-base";
import type { PromptContext } from "../core/types.ts";
import {
  digest,
  type Group,
  type GroupImage,
  groupText,
  IMAGE_NOT_LOADED,
  liveParts,
  referenceLines,
  selectLines,
} from "./group-reference.ts";
import { type ReferenceDetails, referenceEntry, shortHash } from "./transcript-entries.ts";
import { routineResultBlock } from "./volatile-state.ts";

type Message = ContextEvent["messages"][number];

/**
 * What the model was shown of the group (and the previous routine result) by the reference
 * messages a request carries: message text, task/status parts, image attachments, working root,
 * routine result, by id and short hash. It is rebuilt on every request from the reference
 * messages actually present, so after a compaction drops some, their content counts as unseen.
 */
export interface Known {
  messages: Map<string, string>;
  parts: Set<string>;
  images: Set<string>;
  workplace?: string;
  routine?: string;
  /** SEC: hash of the newest run-context block of each kind shown (`context-reference.ts`). */
  context: NonNullable<ReferenceDetails["known"]["context"]>;
  /** A full group reference is present; only then can an update build on it. */
  group: boolean;
}

export const emptyKnown = (): Known => ({
  messages: new Map(),
  parts: new Set(),
  images: new Set(),
  context: {},
  group: false,
});

export function knownFrom(messages: Message[]) {
  const known = emptyKnown();
  for (const message of messages) {
    const details = referenceEntry(message);
    if (!details) continue;
    for (const [id, hash] of Object.entries(details.known.messages)) known.messages.set(id, hash);
    for (const hash of details.known.parts) known.parts.add(hash);
    for (const id of details.known.images) known.images.add(id);
    if (details.known.workplace) known.workplace = details.known.workplace;
    if (details.known.routine) known.routine = details.known.routine;
    if (details.known.context) Object.assign(known.context, details.known.context);
    if (details.kind === "group") known.group = true;
  }
  return known;
}

/** The current routine result block, if any, and its hash. */
export function routine(current: PromptContext | undefined) {
  const block = routineResultBlock(current);
  return block ? { block, hash: shortHash(block) } : undefined;
}

export const workplaceLine = (group: Group) =>
  group.workplace ? `Working root / 工作根: ${group.workplace}` : "";

/** Everything of the group as known after a full reference. */
export function fullKnown(group: Group, current: PromptContext | undefined) {
  const lines = referenceLines(group);
  return {
    messages: Object.fromEntries(lines.map((line) => [line.id, shortHash(line.text)])),
    parts: liveParts(group).map((part) => shortHash(part.text)),
    images: (group.images ?? []).map((block) => block.attachmentId),
    ...(group.workplace ? { workplace: shortHash(group.workplace) } : {}),
    ...(routine(current) ? { routine: routine(current)?.hash } : {}),
  } satisfies ReferenceDetails["known"];
}

const updatedProfile = (profile: string) =>
  `Group profile updated; use this version / 群资料已更新，以此为准:\n${profile}`;

export { updatedProfile };

const omittedNote = (count: number) =>
  `${count} newer group update(s) not shown to fit the context window; read_messages can list them. / 还有 ${count} 条新的群动态因上下文预算未列出，可用 read_messages 查询。`;

/**
 * What changed in the group since `known`, in at most `room` bytes: profile (when it differs from
 * the one the model has as current; never trimmed, it stays authoritative for membership), working
 * root, routine result, task/status parts, new or edited messages (a reply still streaming when
 * an earlier reference was taken comes again, later, so it reads as current) and new image
 * attachments. `omitted` counts what did not fit.
 */
export function groupChanges(
  group: Group,
  current: PromptContext | undefined,
  known: Known,
  profile: { shown?: string; current?: string },
  room: number,
) {
  const body: string[] = [];
  const add: ReferenceDetails["known"] = { messages: {}, parts: [], images: [] };
  const take = (text: string) => {
    const size = Buffer.byteLength(text) + 1;
    if (size > room) return false;
    room -= size;
    return true;
  };
  if (profile.current !== undefined && profile.current !== profile.shown) {
    body.push(updatedProfile(profile.current));
    room -= Buffer.byteLength(profile.current);
  }
  if (group.workplace && shortHash(group.workplace) !== known.workplace) {
    add.workplace = shortHash(group.workplace);
    body.push(groupText(workplaceLine(group)));
    room -= Buffer.byteLength(workplaceLine(group));
  }
  let omitted = 0;
  const result = routine(current);
  if (result && result.hash !== known.routine) {
    add.routine = result.hash;
    if (take(result.block)) body.push(result.block);
    else omitted++;
  }
  for (const part of liveParts(group)) {
    const hash = shortHash(part.text);
    if (known.parts.has(hash) || add.parts.includes(hash)) continue;
    add.parts.push(hash);
    if (take(part.text)) body.push(part.text);
    else if (part.compact !== undefined && take(part.compact)) body.push(part.compact);
    else omitted++;
  }
  const lines = referenceLines(group).filter(
    (line) => known.messages.get(line.id) !== shortHash(line.text),
  );
  for (const line of lines) add.messages[line.id] = shortHash(line.text);
  const selected = selectLines(lines, room);
  if (selected.text) body.push(selected.text);
  omitted += selected.omitted;
  if (omitted) body.push(omittedNote(omitted));
  const blocks = (group.images ?? []).filter((block) => !known.images.has(block.attachmentId));
  for (const block of blocks) add.images.push(block.attachmentId);
  return { body, omitted, add, blocks };
}

/** Group image blocks by digest, for rehydrating persisted reference images. */
export function imagesByDigest(blocks: GroupImage[] | undefined) {
  const out = new Map<string, ImageContent>();
  for (const block of blocks ?? []) {
    const image = ImageContentSchema.parse(block.image);
    out.set(digest(image.data), image);
  }
  return out;
}

/**
 * A reference message with its images in place. The transcript holds only their digests (group
 * attachments never go to the session file); an image the group no longer manages, or that
 * left its snapshot, renders as a fixed note, so the same state renders the same bytes.
 */
export function render(message: Message, images: Map<string, ImageContent>): Message {
  const details = referenceEntry(message);
  if (!details?.images.length || message.role !== "custom" || !Array.isArray(message.content))
    return message;
  const blocks = details.images.map(
    (hash) => images.get(hash) ?? { type: "text" as const, text: IMAGE_NOT_LOADED },
  );
  return { ...message, content: [...blocks, ...message.content] } as Message;
}

/** Image blocks a rendered message carries. */
export const imagesIn = (message: Message) =>
  message.role === "custom" && Array.isArray(message.content)
    ? message.content.filter((part): part is ImageContent => part.type === "image")
    : [];
