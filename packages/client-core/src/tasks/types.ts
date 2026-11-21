import type { ExecutionSettings, TaskSummary, TodoPlan } from "@pibot/protocol";

export interface ExecutionTopic {
  botId: string;
  name: string;
  settings?: ExecutionSettings;
  plan?: TodoPlan;
  tasks: TaskSummary[];
  next: string | null;
  mutating?: boolean;
  loading: boolean;
  error: boolean;
}
