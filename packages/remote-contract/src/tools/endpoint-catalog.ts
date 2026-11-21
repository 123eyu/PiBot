import {
  type CapabilityToolSpec,
  type EndpointCapabilityDefinition,
  RUNNER_CAPABILITY_VERSIONS,
} from "@pibot/protocol-base";
import { ANDROID_PHONE_CAPABILITIES } from "../api/android-capabilities.ts";
import { phoneTools } from "./index.ts";

export const remoteEndpointCapabilities: readonly EndpointCapabilityDefinition[] = [
  ...ANDROID_PHONE_CAPABILITIES.map(({ id, version, key, name }): EndpointCapabilityDefinition => {
    // phone.ui / phone.shell carry no tool until an operation contract exists;
    // the registry keeps a tool-less phone capability unsupported.
    const tools: Record<string, CapabilityToolSpec> =
      key === "calls"
        ? { phone_calls: phoneTools.phone_calls }
        : key === "notifications"
          ? { phone_notifications: phoneTools.phone_notifications }
          : {};
    return {
      id,
      version,
      name,
      kind: "phone" as const,
      attributes: { readOnly: false, writesFile: true, privacy: true, egress: false },
      tools,
      toolNames: Object.keys(tools),
    };
  }),
  {
    id: "phone.media",
    version: 1,
    kind: "phone",
    name: { zh: "照片与视频", en: "Photos and videos" },
    attributes: { readOnly: true, writesFile: false, privacy: true, egress: false },
    tools: { phone_media: phoneTools.phone_media, phone_media_get: phoneTools.phone_media_get },
    toolNames: ["phone_media", "phone_media_get"],
  },
  {
    id: "phone.sms",
    version: 1,
    kind: "phone",
    name: { zh: "短信验证码", en: "SMS codes" },
    attributes: { readOnly: true, writesFile: false, privacy: true, egress: false },
    tools: { phone_sms_code: phoneTools.phone_sms_code },
    toolNames: ["phone_sms_code"],
  },
  {
    id: "runner.computer",
    version: 1,
    kind: "runner",
    name: { zh: "操作电脑", en: "Computer" },
    attributes: { readOnly: false, writesFile: true, privacy: true, egress: true },
    tools: {},
    toolNames: [
      "screenshot",
      "ui_tree",
      "ui_action",
      "pointer",
      "keys",
      "open_app",
      "open_file",
      "list_apps",
    ],
  },
  {
    // No model tool; group parallel tasks use it through the control side's worktree flow.
    id: "runner.managed-git",
    version: RUNNER_CAPABILITY_VERSIONS["runner.managed-git"],
    kind: "runner",
    name: { zh: "群并行工作区", en: "Parallel group workspaces" },
    attributes: { readOnly: false, writesFile: true, privacy: true, egress: false },
    tools: {},
    toolNames: [],
  },
  ...(["exec", "files", "background"] as const).map((id) => ({
    id: `runner.${id}`,
    version: RUNNER_CAPABILITY_VERSIONS[`runner.${id}`],
    kind: "runner" as const,
    name: {
      zh: { exec: "运行命令", files: "文件", background: "后台作业" }[id],
      en: { exec: "Run commands", files: "Files", background: "Background jobs" }[id],
    },
    attributes: { readOnly: false, writesFile: true, privacy: true, egress: id !== "files" },
    tools: {},
    toolNames:
      id === "exec"
        ? ["run_command"]
        : id === "background"
          ? ["background_command", "write_stdin"]
          : [
              "read_file",
              "list_dir",
              "find_files",
              "search_text",
              "write_file",
              "edit_file",
              "apply_patch",
            ],
  })),
];
