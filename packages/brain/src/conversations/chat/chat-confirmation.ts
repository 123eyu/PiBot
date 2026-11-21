/** User confirmation and its normal chat reply must commit in one transaction. */
export interface ChatConfirmation {
  commit(): void;
  beforeCommit(): Promise<void>;
  signal: AbortSignal;
}
