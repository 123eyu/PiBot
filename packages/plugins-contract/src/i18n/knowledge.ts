// The knowledge tab of the Connections page and its errors. Keys stay flat so the i18n
// table stays one lookup; the page adds only strings it actually renders.
export const knowledgeZh = {
  "knowledge.category": "知识库",
  "knowledge.empty": "Pi Bot 可以连接 Obsidian 笔记库和 Notion，让 Bot 查你的笔记并注明出处。",
  "knowledge.emptyTitle": "还没有知识库",
  "knowledge.added": "已添加",
  "knowledge.addTitle": "添加知识库",
  "knowledge.account": "账号",
  "knowledge.account.workspace": "工作区",
  "knowledge.account.name": "名字",
  "knowledge.account.email": "邮箱",
  "knowledge.account.loading": "正在读取账号信息…",
  "knowledge.account.unavailable": "未能读取账号信息",
  "knowledge.account.reason.no_bot": "先把它给一个 Bot 用，再点重试；读取会按那个 Bot 的权限走。",
  "knowledge.account.reason.signin": "登录 Notion 后会显示。",
  "knowledge.account.reason.tool_missing":
    "这个 Notion 连接不提供账号信息（团队工作区的连接可能没有），连接本身照常可用。",
  "knowledge.account.reason.denied": "权限设置不允许自动读取，连接本身照常可用。",
  "knowledge.account.reason.failed": "Notion 这次没有回应，稍后再试。",
  "knowledge.account.reason.unreadable": "Notion 的回答里没有找到账号信息。",
  "knowledge.empty.addObsidian": "添加 Obsidian 文件夹",
  "knowledge.empty.addNotion": "连接 Notion",
  "knowledge.detected": "在这台电脑上找到的 Obsidian 库",
  "knowledge.detected.note": "从 Obsidian 自己的笔记库列表读出，只添加文件夹路径，不读笔记内容。",
  "knowledge.installed": "已安装",
  "knowledge.add": "添加",
  "knowledge.add.notion": "Notion",
  "knowledge.add.notionHint": "用 Notion 账号登录，只读",
  "knowledge.add.obsidian": "Obsidian 库",
  "knowledge.add.obsidianHint": "选一个库文件夹，只在本机读",
  "knowledge.picking": "请在窗口里选择库所在的文件夹…",
  "knowledge.origin": "来源",
  "knowledge.notionNote":
    "会打开浏览器让你登录 Notion。能读到哪些页面，由你在 Notion 里授权给 Pi Bot 的范围决定；查询这个知识源的，只有下面分到的 Bot。",
  "knowledge.notionConnect": "登录 Notion",
  "knowledge.removed": "已断开「{name}」",
  "knowledge.kind.obsidian": "Obsidian 库",
  "knowledge.kind.notion": "Notion",
  "knowledge.origin.obsidian": "文件夹：{path}",
  "knowledge.origin.notion": "Notion 连接",
  "knowledge.lastUsed": "最近一次：{time}",
  "knowledge.neverUsed": "还没有使用过",
  "knowledge.remove": "断开",
  "knowledge.removeNote": "只删除这条记录，不会改动你的笔记或 Notion 页面。",
  "knowledge.removeConfirm": "断开「{name}」？",
  "knowledge.readOnlyNote": "Bot 只读这里的内容，不会修改笔记。",
  "knowledge.error.picker_unavailable": "现在打不开选择文件夹的窗口，请打开 Pi Bot 窗口后再试。",
  "knowledge.error.busy": "正在处理上一个知识库，请稍候再试。",
  "knowledge.error.vault_not_detected":
    "这个库不在这台电脑的 Obsidian 列表里了，请重新查找或直接选文件夹。",
  "knowledge.error.vault_missing": "选择的文件夹不存在或读不了，请重新选择。",
  "knowledge.error.vault_not_directory": "选择的不是文件夹，请重新选择 Obsidian 库所在的文件夹。",
  "knowledge.error.vault_changed": "知识源文件夹已变化，请重新选择。",
  "knowledge.error.vault_invalid": "选择的位置不是有效的本地文件夹，请重新选择。",
  "knowledge.error.vault_unreadable": "没有权限读取这个文件夹，请检查系统的文件访问权限后重试。",
  "knowledge.error.source_missing": "这个知识源已经不存在，列表已刷新。",
  "knowledge.error.connector_missing": "这个知识源对应的连接已经不存在，请重新添加。",
  "knowledge.error.notion_search_tool_missing": "这个 Notion 连接没有可用的搜索工具。",
  "knowledge.error.notion_read_tool_missing": "这个 Notion 连接没有可用的读取工具。",
  "knowledge.error.notion_query_empty": "要搜的内容不能为空。",
  "knowledge.error.notion_ref_empty": "要读的页面不能为空。",
  "knowledge.openNote": "在 Obsidian 中打开",
  "knowledge.openingNote": "正在打开…",
  "knowledge.error.reference_invalid": "这条引用不在回复里，或不是可打开的 Obsidian 笔记链接。",
  "knowledge.error.reference_missing": "找不到这条回复，可能已被删除。",
  "knowledge.error.reference_changed": "知识源或引用已变化，请刷新后重新点击。",
  "knowledge.error.reference_reselect":
    "这个知识源是旧版本添加的，请在「连接」里重新选择一次再打开。",
  "knowledge.error.reference_unsupported": "这台电脑上暂时打不开 Obsidian 链接。",
  "knowledge.error.reference_denied":
    "这个知识源被权限设置拒绝了，点击打开不能绕过「读取文件」的权限。",
  "knowledge.error.reference_unknown":
    "已经交给 Obsidian，但无法确认它是否打开。请先看看 Obsidian 窗口，不要重复点击。",
} as const;

export const knowledgeEn = {
  "knowledge.category": "Knowledge",
  "knowledge.empty":
    "Pi Bot can connect an Obsidian vault and Notion, so Bots can search your notes and say where each answer came from.",
  "knowledge.emptyTitle": "No knowledge sources yet",
  "knowledge.added": "Added",
  "knowledge.addTitle": "Add a knowledge source",
  "knowledge.account": "Account",
  "knowledge.account.workspace": "Workspace",
  "knowledge.account.name": "Name",
  "knowledge.account.email": "Email",
  "knowledge.account.loading": "Reading the account…",
  "knowledge.account.unavailable": "Couldn't read the account",
  "knowledge.account.reason.no_bot":
    "Give it to a Bot first, then retry; the read follows that Bot's permissions.",
  "knowledge.account.reason.signin": "Shown after you sign in to Notion.",
  "knowledge.account.reason.tool_missing":
    "This Notion connection doesn't share account details (team workspace connections may not); the connection still works.",
  "knowledge.account.reason.denied":
    "Your permission settings don't allow reading it automatically; the connection still works.",
  "knowledge.account.reason.failed": "Notion didn't answer this time. Try again later.",
  "knowledge.account.reason.unreadable": "No account details were found in Notion's answer.",
  "knowledge.empty.addObsidian": "Add an Obsidian folder",
  "knowledge.empty.addNotion": "Connect Notion",
  "knowledge.detected": "Obsidian vaults found on this computer",
  "knowledge.detected.note":
    "Read from Obsidian's own vault list; only the folder path is added, never your notes.",
  "knowledge.installed": "Installed",
  "knowledge.add": "Add",
  "knowledge.add.notion": "Notion",
  "knowledge.add.notionHint": "Sign in with Notion, read only",
  "knowledge.add.obsidian": "Obsidian vault",
  "knowledge.add.obsidianHint": "Pick a vault folder, read on this computer",
  "knowledge.picking": "Choose the vault's folder in the dialog…",
  "knowledge.origin": "Source",
  "knowledge.notionNote":
    "Opens your browser to sign in to Notion. Which pages can be read follows what you grant Pi Bot in Notion; only the Bots assigned below can query this source.",
  "knowledge.notionConnect": "Sign in to Notion",
  "knowledge.removed": "Disconnected “{name}”",
  "knowledge.kind.obsidian": "Obsidian vault",
  "knowledge.kind.notion": "Notion",
  "knowledge.origin.obsidian": "Folder: {path}",
  "knowledge.origin.notion": "Notion connection",
  "knowledge.lastUsed": "Last used: {time}",
  "knowledge.neverUsed": "Not used yet",
  "knowledge.remove": "Disconnect",
  "knowledge.removeNote":
    "This removes the record only; your notes and Notion pages are left untouched.",
  "knowledge.removeConfirm": "Disconnect “{name}”?",
  "knowledge.readOnlyNote": "Bots read from here and never change your notes.",
  "knowledge.error.picker_unavailable":
    "The folder dialog is not available right now. Open the Pi Bot window and try again.",
  "knowledge.error.busy": "Another knowledge source is still being handled; try again in a moment.",
  "knowledge.error.vault_not_detected":
    "That vault is not in this computer's Obsidian list any more. Search again or pick the folder instead.",
  "knowledge.error.vault_missing": "That folder is gone or unreadable. Choose it again.",
  "knowledge.error.vault_not_directory":
    "That is not a folder. Choose the folder that holds your Obsidian vault.",
  "knowledge.error.vault_changed": "The knowledge source folder changed. Choose it again.",
  "knowledge.error.vault_invalid": "That location is not a valid local folder. Choose it again.",
  "knowledge.error.vault_unreadable":
    "Pi Bot does not have permission to read that folder. Check the system file access settings and try again.",
  "knowledge.error.source_missing":
    "That knowledge source no longer exists; the list was refreshed.",
  "knowledge.error.connector_missing":
    "The connection behind this knowledge source is gone. Add it again.",
  "knowledge.error.notion_search_tool_missing": "This Notion connection has no usable search tool.",
  "knowledge.error.notion_read_tool_missing": "This Notion connection has no usable read tool.",
  "knowledge.error.notion_query_empty": "Enter something to search for.",
  "knowledge.error.notion_ref_empty": "Choose a page to read.",
  "knowledge.openNote": "Open in Obsidian",
  "knowledge.openingNote": "Opening…",
  "knowledge.error.reference_invalid":
    "This reference is not in the reply, or is not an openable Obsidian note link.",
  "knowledge.error.reference_missing": "That reply cannot be found; it may have been deleted.",
  "knowledge.error.reference_changed":
    "The knowledge source or the reference changed. Refresh and click again.",
  "knowledge.error.reference_reselect":
    "This knowledge source was added by an older version. Choose it again in Connections, then open the note.",
  "knowledge.error.reference_unsupported":
    "Obsidian links cannot be opened on this computer right now.",
  "knowledge.error.reference_denied":
    "Your file permissions deny this knowledge source, and clicking cannot override a read denial.",
  "knowledge.error.reference_unknown":
    "It was handed to Obsidian, but whether it opened cannot be confirmed. Check Obsidian before clicking again.",
} as const;
