/** Internal preparation provenance, never an RPC input or an executable capability. */
export interface ManagedConfigCall {
  botId: string;
  runId: string;
  toolCallId: string;
  conversationKey: string;
  topicId: string;
  conversationId?: string;
  groupId?: string;
}
export interface ManagedConfigDirectory {
  path: string;
  device: string;
  inode: string;
}
export interface ManagedBranchConfigBinding {
  purpose: "af8-own-branch-pushremote";
  call: Readonly<ManagedConfigCall>;
  registryId: string;
  registryVersion: number;
  source: Readonly<ManagedConfigDirectory>;
  primary: Readonly<ManagedConfigDirectory>;
  git: Readonly<ManagedConfigDirectory>;
  common: Readonly<ManagedConfigDirectory>;
  branch: string;
  head: string;
  cwd: string;
  key: string;
  targetPath: string;
  intentDigest: string;
  beforeVersion: string;
  bindingDigest: string;
}
/** Only prepare can inject this call-bound adapter. The AF8 publication handle stays private. */
export interface ManagedGitConfigurationPolicyInput {
  readonly binding: Readonly<ManagedBranchConfigBinding>;
  verifyCurrent(requirement: Readonly<ManagedBranchConfigBinding>): "current" | "changed";
}
