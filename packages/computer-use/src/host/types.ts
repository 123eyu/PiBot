export type GuardRenderState = {
  labels: {
    pause: string;
    resume: string;
    stop: string;
    allow: string;
    skip: string;
    hint: string;
  };
  rows: {
    botId: string;
    /** Avatar colour token name (`--avatar-<color>`); the dot falls back to the default. */
    color?: string;
    mode: "background" | "foreground" | "paused" | "waiting";
    text: string;
    canPause: boolean;
    canResume: boolean;
    confirm: { requestId: string; text: string } | null;
  }[];
};

export interface GuardWindow {
  show(state: GuardRenderState): void;
  hide(): void;
  destroy(): void;
}
