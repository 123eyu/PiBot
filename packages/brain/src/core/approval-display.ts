import type { LocalToolCall } from "@pibot/agent";
import type { ApprovalFact } from "@pibot/protocol-base";

const warnings: Record<string, [string, string]> = {
  memory_scope_user: [
    "这条记忆由所有 Bot 和群聊共用",
    "This memory is shared with all Bots and group conversations",
  ],
  background_stdin: [
    "输入可能执行新的代码；只批准本次写入，不保存为以后允许",
    "Input may execute new code; approval covers this write only and cannot be remembered",
  ],
  docker_access: [
    "Docker 可挂载宿主目录、访问工作文件夹之外的文件和网络；撤销不停止已有容器或删除数据卷",
    "Docker can mount host folders and access files and networks outside the workspace; revocation does not stop containers or remove volumes",
  ],
  docker_unisolated: [
    "本次 Docker 客户端未隔离（仅直接执行 Docker，不执行宿主 Shell）",
    "This Docker client is not isolated (direct Docker execution only, not a host shell)",
  ],
  // Same wording as facts.value.unknown_command_directory(_sandboxed) in @pibot/i18n: the cards
  // here render `localized` facts, so a code missing from this table showed up as raw text.
  unknown_command_directory: [
    "写入位置无法确定，且本次命令不在已确认的隔离沙箱内，需要逐次确认",
    "The write location is unknown and this command has no confirmed sandbox; approve this call individually",
  ],
  unknown_command_directory_sandboxed: [
    "写入位置无法确定，由隔离沙箱限制在工作位置内；本次确认不能记住或用于例行预授权",
    "The write location is unknown; the sandbox restricts writes to the working folders. This approval cannot be remembered or used for routine preauthorization",
  ],
  readonly: ["只读操作", "Read-only operation"],
  incomplete_analysis: [
    "无法完全确定会做什么，不能记住授权",
    "The operation cannot be fully determined; permission cannot be remembered",
  ],
  windows_unisolated: [
    "此命令将在 Windows 上以你的权限运行，没有系统隔离",
    "This command runs on Windows with your permissions and without system isolation",
  ],
  outside_sandbox_login: [
    "这个程序要用你自己的登录或配置（如 aws、gh、kubectl、ssh 的凭据），在沙箱里跑不通，所以直接请你批准在沙箱外运行",
    "This program needs your own login or configuration (aws, gh, kubectl, ssh credentials and the like) and cannot work inside the sandbox, so it asks to run outside it",
  ],
  system_service: ["只放行这一项系统服务。", "Only this system service is allowed."],
  local_service: [
    "本机服务：只放行卡片上列出的这一个回环端口或套接字，其他端口和外网仍拦",
    "Local service: only the one loopback port or socket listed on the card opens; Other ports and the internet stay blocked",
  ],
  outside_sandbox: [
    "这次在沙箱外运行，没有文件和网络隔离：能读写你的整个用户目录、访问任意网络。只放行这一次，不会记住",
    "This run is outside the sandbox, with no file or network isolation: it can read and write your whole user folder and reach any network. Allowed this once only, never remembered",
  ],
  acp_editor_terminal_unisolated: [
    "命令将由编辑器终端直接执行；Pi Bot 无法证明编辑器提供了系统隔离",
    "The command runs directly in the editor terminal; Pi Bot cannot verify system isolation there",
  ],
  editor_session_rememberable: [
    "可选「本次会话都允许」：仅本 ACP 会话内，同样的程序和参数不再询问；会话结束即失效，不保存为授权",
    "“Allow for this session” covers the same program and arguments in this ACP session only; it ends with the session and is never saved as a permission",
  ],
  remove_workplace_root: ["将删除整个工作位置", "Deletes the entire workplace"],
  system_settings: ["可能修改系统设置", "May change system settings"],
  force_push: ["将强制推送 Git 历史", "Force-pushes Git history"],
  hard_remote_reset: [
    "将丢弃本地修改并重置 Git 历史",
    "Discards local changes and resets Git history",
  ],
  shutdown: ["将关闭或重启电脑", "Shuts down or restarts the computer"],
  kill_init: ["将终止系统关键进程", "Terminates a critical system process"],
  killall_without_target: ["将批量终止进程", "Terminates multiple processes"],
  download_and_execute: ["将下载并执行外部代码", "Downloads and executes external code"],
  browser_submit: [
    "提交会把页面里填写的内容发给这个网站",
    "Submitting sends what was filled in on the page to this website",
  ],
  paid_generation: [
    "这次生成会由图片服务商收费；拒绝则不会发出请求",
    "The image service bills this generation; denying sends no request",
  ],
};
/**
 * What a paid image request will cost, from the dispatch record only. The prompt is
 * never part of `call.input`, so it cannot reach the card, the audit or the notification.
 */
function imageFacts(call: LocalToolCall, zh: boolean): ApprovalFact[] {
  const text = (value: unknown) =>
    typeof value === "string" && value ? value.slice(0, 200) : zh ? "未知" : "unknown";
  const count = typeof call.input.count === "number" ? call.input.count : 1;
  const size =
    call.input.size === "auto" || call.input.size === undefined
      ? zh
        ? "自动（由服务商按画面决定）"
        : "auto (chosen by the service)"
      : text(call.input.size);
  // The image catalog carries no prices (cost -1), so no estimate is invented here.
  const cost = zh ? "未知（模型目录没有价格）" : "unknown (no price in the model catalog)";
  return [
    {
      kind: "warning",
      value: zh
        ? `服务商 ${text(call.input.provider)} · 模型 ${text(call.input.model)}`
        : `Provider ${text(call.input.provider)} · model ${text(call.input.model)}`,
    },
    {
      kind: "warning",
      value: zh ? `尺寸 ${size} · 数量 ${count} 张` : `Size ${size} · ${count} image(s)`,
    },
    { kind: "warning", value: zh ? `预计费用 ${cost}` : `Estimated cost ${cost}` },
  ];
}
/** `bot` is the asking Bot's (already redacted) name; titles used to be hard-coded to "Pi". */
export function approvalDisplay(
  call: LocalToolCall,
  facts: ApprovalFact[],
  language: "zh" | "en",
  bot = "Pi",
  about: { secrets?: boolean; connector?: { name: string; tool: string } } = {},
) {
  const index = language === "zh" ? 0 : 1;
  const acpTerminal =
    call.tool === "run_command" &&
    facts.some(
      (fact) => fact.kind === "warning" && fact.value === "acp_editor_terminal_unisolated",
    );
  const connector = about.connector;
  const connectorTitle: [string, string] | undefined = connector && [
    `${bot}想用 ${connector.name} 读取：${connector.tool}`,
    `${bot} wants to use ${connector.name} to read: ${connector.tool}`,
  ];
  const titles: Record<string, [string, string]> = {
    memory_add: [`${bot} 想保存一条记忆`, `${bot} wants to save a memory`],
    memory_update: [`${bot} 想修改一条记忆`, `${bot} wants to update a memory`],
    memory_remove: [`${bot} 想删除一条记忆`, `${bot} wants to remove a memory`],
    connector_call: connectorTitle ?? [
      `${bot} 想使用连接的只读工具`,
      `${bot} wants to use a connected read-only tool`,
    ],
    read_messages: [`${bot} 想查询获准聊天历史`, `${bot} wants to query permitted chat history`],
    image_generation: [`${bot} 想生成图片`, `${bot} wants to generate an image`],
    // The agent's name is the card's first fact (the policy request names it).
    delegate_to_agent: [
      `${bot} 想把一项工作交给外部 Agent`,
      `${bot} wants to hand a piece of work to an external agent`,
    ],
    run_command: about.secrets
      ? [`${bot}想在命令里使用访问令牌`, `${bot} wants to use an access token in a command`]
      : [
          acpTerminal ? `${bot} 想让编辑器终端直接运行命令` : `${bot} 想在你的电脑上运行命令`,
          acpTerminal
            ? `${bot} wants the editor terminal to run a command directly`
            : `${bot} wants to run a command on your computer`,
        ],
    write_stdin: [`${bot} 想向后台进程写入`, `${bot} wants to write to a background process`],
    web_fetch: [`${bot} 想访问网站`, `${bot} wants to visit a website`],
    web_search: [
      "查询词会发给 DuckDuckGo（duckduckgo.com）",
      "Queries will be sent to DuckDuckGo (duckduckgo.com)",
    ],
    project_notes: [
      `${bot} 想更新项目背景（AGENTS.md）`,
      `${bot} wants to update project notes (AGENTS.md)`,
    ],
    write_file: [`${bot} 想写入文件`, `${bot} wants to write a file`],
    edit_file: [`${bot} 想修改文件`, `${bot} wants to edit a file`],
    apply_patch: [`${bot} 想应用文件补丁`, `${bot} wants to apply a file patch`],
    read_file: [`${bot} 想读取文件`, `${bot} wants to read a file`],
    reveal_in_folder: [`${bot} 想在文件夹中显示文件`, `${bot} wants to show a file in its folder`],
    list_dir: [`${bot} 想列出目录`, `${bot} wants to list a directory`],
    find_files: [`${bot} 想在文件夹里找文件`, `${bot} wants to find files in a folder`],
    search_text: [
      `${bot} 想在文件或文件夹里搜索内容`,
      `${bot} wants to search a file or folder's contents`,
    ],
    // Bot browser: site visits, and form submissions confirmed per site and run.
    browser_open: [
      `${bot} 想用自己的浏览器访问网站`,
      `${bot} wants to visit a website in its own browser`,
    ],
    browser_submit: [
      `${bot} 想在这个网站上提交表单`,
      `${bot} wants to submit a form on this website`,
    ],
  };
  if (call.tool === "image_result") {
    const actions: Record<string, [string, string]> = {
      inspect: [`${bot} 想查看已生成图片`, `${bot} wants to inspect generated images`],
      resend: [`${bot} 想重发已生成图片附件`, `${bot} wants to resend generated image attachments`],
      save: [`${bot} 想读取已生成图片以保存`, `${bot} wants to read generated images for saving`],
    };
    return {
      title: actions[String(call.input.action)]?.[index] ?? titles.read_file?.[index] ?? "",
      facts: [
        ...facts,
        {
          kind: "warning" as const,
          value:
            language === "zh"
              ? "仅复用受管图片附件，不重新生成。保存另须写入权限。"
              : "Reuses managed image attachments without generation. Saving requires separate write permission.",
        },
      ],
    };
  }
  const service = facts.find(
    (fact) =>
      fact.kind === "warning" &&
      (fact.value === "local_service" || fact.value === "system_service"),
  )?.value;
  if (service)
    titles.run_command =
      service === "local_service"
        ? [`${bot} 想连接本机服务`, `${bot} wants to connect to a local service`]
        : [`${bot} 想使用系统服务`, `${bot} wants to use a system service`];
  const extra = call.tool === "image_generation" ? imageFacts(call, index === 0) : [];
  return {
    title:
      titles[call.tool]?.[index] ??
      // A capability tool served by a connection is titled by that connection.
      connectorTitle?.[index] ??
      (language === "zh" ? `${bot} 请求你的允许` : `${bot} requests your permission`),
    facts: [
      ...extra,
      ...facts.map((fact) =>
        fact.kind === "warning" && fact.value.startsWith("command_home:")
          ? {
              ...fact,
              value: `${language === "zh" ? "命令的初始 Bot 主目录" : "Initial command Bot home"}: ${fact.value.slice("command_home:".length)}`,
            }
          : fact.kind === "warning" && warnings[fact.value]
            ? { ...fact, value: warnings[fact.value]?.[index] ?? fact.value }
            : fact,
      ),
    ],
  };
}
