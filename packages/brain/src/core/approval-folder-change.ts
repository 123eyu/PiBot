export interface PreparedApprovalFolderChange {
  /** Runs inside the approval's resolution transaction, after the pending-card check. */
  commit(): void;
  /** Only in-memory snapshot replacement, after the transaction really committed. */
  committed(): void;
}

export type ApprovalFolderChange = (
  signal: AbortSignal,
  assertPending: () => void,
) => Promise<PreparedApprovalFolderChange | null>;
