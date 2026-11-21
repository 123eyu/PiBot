import type { ManagedIdentity } from "@pibot/storage";
export interface ChangesRoot {
  id: string;
  name: string;
  path: string;
  role: "primary" | "readonly" | "writable";
  kind?: "worktree";
  device: string | null;
  inode: string | null;
}
/** Everything a changes request needs, resolved fresh from the folder boundary on every call. */
export interface ChangesScope {
  conversationKey: string;
  topicId?: string;
  botId: string;
  botName: string;
  /** The executing Bot's home: sandboxed writes run with it as HOME and log there. */
  home: string;
  groupId?: string;
  conversationId?: string;
  roots: ChangesRoot[];
  /** Registry-backed SCM choices; never part of execution or management authority. */
  views?: ChangesRoot[];
  root: ChangesRoot;
  primary: ChangesRoot;
  /** Global boundary conflict remains authoritative when selecting another checkpoint root. */
  boundaryConflict: boolean;
  /** The selected root has a read-only overlap, or the whole boundary is conflicted. */
  nestedReadonly: boolean;
  readonlySource?: string;
}

export interface WorktreeReceipt {
  rootId: string;
  source: ManagedIdentity;
  root: ManagedIdentity;
  git: ManagedIdentity;
  common: ManagedIdentity;
  gitPointer: string | null;
}
