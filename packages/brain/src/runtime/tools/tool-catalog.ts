import type { LocalToolDefinition, LocalToolResult } from "@pibot/agent";
import type { CapabilityToolRegistry } from "@pibot/protocol-base";

export const KERNEL_GROUP_IDS = [
  "commands",
  "computer",
  "skills",
  "memory",
  "review",
  "history",
  "images",
  "browser",
  "apps",
  "office",
  "network",
] as const;
type KernelGroup = (typeof KERNEL_GROUP_IDS)[number];
const kernelGroups: Record<KernelGroup, { description: string; tools: readonly string[] }> = {
  commands: {
    description:
      "命令执行与后台命令：run_command、background_command、write_stdin；当前可见项是已可用的核心工具，执行仍需权限 / Command execution and background jobs: currently visible tools are already active core tools; execution still requires permission",
    tools: ["run_command", "background_command", "write_stdin"],
  },
  office: {
    description:
      "本地Word/Excel/PPT：读取、生成、编辑、转换、校验和内容预览 / Local Office documents: read, create, edit, convert, validate and preview",
    tools: [
      "office_inspect",
      "office_read",
      "office_create",
      "office_edit",
      "office_preview",
      "office_validate",
      "office_render",
      "office_capabilities",
      "office_convert",
    ],
  },
  // Fixed text (prompt cache): tool_discover lists this, and "desktop apps" alone read as fine
  // for opening a web page in Safari (maintainers 2026-11-14).
  computer: {
    description:
      "操作电脑：桌面应用、界面树、截图与键鼠；网页用 Bot 浏览器（browser_open），不用它开 Safari / Chrome / Desktop apps, accessibility, screenshots and input; web pages go to the Bot browser (browser_open), not to Safari or Chrome through these tools",
    tools: ["screenshot", "ui_tree", "ui_action", "pointer", "keys", "open_app", "open_file"],
  },
  skills: {
    description: "读取或保存可复用技能 / Read or propose reusable skills",
    tools: ["skill_propose"],
  },
  // Maintainers 2026-11-14: diagnosing the user's own network (routes, Wi-Fi, a device on the LAN).
  network: {
    description:
      "本机网络：网卡、路由、ARP、DNS、Wi-Fi 状态（只读，无需确认），ping 本地网络设备（每个地址每次任务确认一次） / This computer's network: interfaces, routes, ARP, DNS and Wi-Fi state (read-only, no card); ping a local-network device (asked once per host and task)",
    tools: ["local_network"],
  },
  memory: {
    description:
      "保存、更新、删除自己的记忆；目录只有摘要，涉及具体数字、名字或步骤时先用 memory_read 读全文，目录没有匹配项时用 memory_search / Add, update or remove own memories; catalog entries are summaries, so use memory_read before answering with specific numbers, names or steps, and use memory_search when no catalog entry matches",
    // Project background is project-scoped memory; Bots no longer write AGENTS.md.
    tools: ["memory_add", "memory_update", "memory_remove", "memory_search", "memory_read"],
  },
  review: {
    description:
      "代码导航、独立审查、问题记录和交付证据 / Code navigation, independent review, findings and delivery evidence",
    tools: [
      "code_navigate",
      "code_outline",
      "code_symbols",
      "code_map",
      "review_start",
      "review_read",
      "review_finding",
      "delivery_evidence",
    ],
  },
  history: {
    description: "额外话题、群与任务历史 / Extra topic, group and task history",
    tools: ["read_messages"],
  },
  images: {
    description:
      "查看、重发、保存已生成图片；不生成新图 / Inspect, resend or save existing generated images only",
    tools: ["image_result"],
  },
  browser: {
    description:
      "浏览器截图、诊断、样式、选择框、下载，以及用用户在 Pi Bot 里保存的账号密码登录网站（browser_login，含两步登录，账号密码由工具自己填，Bot 看不到密码） / Browser screenshots, diagnostics, styles, selects, downloads, and logging in to a website with an account the user saved in Pi Bot (browser_login, two-step logins included; the tool fills the account and password itself and the Bot never sees the password)",
    tools: [
      "browser_screenshot",
      "browser_network",
      "browser_request",
      "browser_secret",
      "browser_diagnostics",
      "browser_inspect",
      "browser_select",
      "browser_download_list",
      "browser_login",
    ],
  },
  apps: {
    description:
      "连接应用（含本机通讯录、日历；未连接用 connection_needed） / Connected apps, including desktop contacts and calendar; use connection_needed when not connected",
    tools: ["connector_discover", "connector_call"],
  },
};
// Capability groups come from the protocol aggregate; their tools are the specs naming them.
function catalog(registry: CapabilityToolRegistry) {
  const ids = [...KERNEL_GROUP_IDS, ...registry.groups.map((group) => group.id)];
  const groups: Record<string, { description: string; tools: readonly string[] }> = {
    ...kernelGroups,
    ...Object.fromEntries(
      registry.groups.map((group) => [
        group.id,
        {
          description: group.description,
          tools: Object.entries(registry.specs)
            .filter(([, spec]) => spec.group === group.id)
            .map(([name]) => name),
        },
      ]),
    ),
  };
  groups.apps = {
    ...kernelGroups.apps,
    tools: [
      ...kernelGroups.apps.tools,
      ...Object.entries(registry.specs)
        .filter(([, spec]) => spec.group === "apps")
        .map(([name]) => name),
    ],
  };
  groups.skills = {
    ...kernelGroups.skills,
    tools: [
      ...kernelGroups.skills.tools,
      ...Object.entries(registry.specs)
        .filter(([, spec]) => spec.group === "skills")
        .map(([name]) => name),
    ],
  };
  const byName = new Map(
    ids.flatMap((id) => groups[id]?.tools.map((name) => [name, id] as const) ?? []),
  );
  return { ids, groups, byName };
}

export function toolLoadGroup(
  name: string,
  registry: CapabilityToolRegistry,
): LocalToolDefinition["loadGroup"] {
  const { byName, groups } = catalog(registry);
  const id = byName.get(name);
  // Commands remain core: discovery must not remove their existing immediate availability.
  if (id === "commands") return undefined;
  return id && groups[id] ? { id, description: groups[id].description } : undefined;
}

/** Only advertise groups present in the run's filtered catalog, never the global registry. */
export function scopedToolCatalog(
  definitions: LocalToolDefinition[],
  registry: CapabilityToolRegistry,
): LocalToolDefinition[] {
  const { ids, groups } = catalog(registry);
  const present = new Set(
    definitions.flatMap((tool) => (tool.loadGroup ? [tool.loadGroup.id] : [])),
  );
  if (definitions.some((tool) => kernelGroups.commands.tools.includes(tool.name)))
    present.add("commands");
  const available = ids.filter((id) => present.has(id));
  return definitions.flatMap((tool) =>
    tool.name !== "tool_discover"
      ? [tool]
      : available.length
        ? [
            {
              ...tool,
              description: [
                tool.description,
                ...available.map((id) => `${id}: ${groups[id]?.description ?? id}`),
                ...(!definitions.some((entry) => entry.name === "run_command")
                  ? [commandUnavailable]
                  : []),
              ].join("\n"),
            },
          ]
        : [],
  );
}

const commandUnavailable =
  "run_command 当前权限或运行模式不可用；不要改用其他工具绕过命令限制。如需执行，请说明限制，由用户调整 Bot 权限 / run_command is unavailable under current permissions or run mode. Do not bypass command restrictions through other tools; explain the limitation so the user can adjust Bot permissions if needed.";

/** Value-free facts for the diagnostics log: only catalog group ids, never model-chosen text. */
export function discoveryDiagnostics(
  definitions: readonly LocalToolDefinition[],
  requested: readonly string[],
  registry: CapabilityToolRegistry,
) {
  const known = new Set(catalog(registry).ids);
  const present = new Set(definitions.flatMap((tool) => tool.loadGroup?.id ?? []));
  if (definitions.some((tool) => kernelGroups.commands.tools.includes(tool.name)))
    present.add("commands");
  const named = [...new Set(requested)].filter((id) => known.has(id));
  return {
    requested: named,
    unavailable: named.filter((id) => !present.has(id)),
    unknownCount: requested.filter((id) => !known.has(id)).length,
  };
}

export function discoverTools(
  definitions: readonly LocalToolDefinition[],
  requested: readonly string[],
): LocalToolResult {
  const selected = new Set(requested);
  const found = definitions.filter(
    (tool) =>
      (tool.loadGroup && selected.has(tool.loadGroup.id)) ||
      (selected.has("commands") && kernelGroups.commands.tools.includes(tool.name)),
  );
  const available = new Set(found.map((tool) => tool.loadGroup?.id));
  if (found.some((tool) => kernelGroups.commands.tools.includes(tool.name)))
    available.add("commands");
  const missing = requested.filter((id) => !available.has(id));
  return {
    text: [
      "工具发现不授予操作权限；下一次请求可用 / Discovery grants no operation permission; available next request:",
      ...found.map((tool) => `- ${tool.name}`),
      ...(selected.has("commands") && !found.some((tool) => tool.name === "run_command")
        ? [commandUnavailable]
        : []),
      ...(missing.length
        ? [`当前运行不可用 / Unavailable in this run: ${missing.join(", ")}`]
        : []),
    ].join("\n"),
    loadedTools: found.filter((tool) => tool.loadGroup).map((tool) => tool.name),
  };
}
