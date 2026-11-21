// YOLO: a switch on one conversation that stops asking for permission there.
export const yoloZh = {
  "yolo.menu": "更多",
  "yolo.menuItem": "YOLO 模式",
  "yolo.menuOn": "已开启 · 点击关闭",
  "yolo.menuOff": "这个对话里不再询问权限",
  "yolo.badge": "YOLO · 不再询问",
  "yolo.badgeHint": "这个对话开着 YOLO：可自动批准的操作不再询问；逐次确认和硬拒绝仍然有效。",
  "yolo.turnOff": "关闭 YOLO",
  "yolo.confirmTitle": "在这个对话里开启 YOLO？",
  "yolo.confirmIntro":
    "开启后，这个对话里可由 YOLO 批准的操作会自动允许，不再问你。只影响这一个对话：新建话题或会话时自动关闭，不影响别的对话和例行任务。",
  "yolo.confirmGroup": "群聊里所有成员 Bot 在这个会话（包括任务线程）里遵循相同的 YOLO 规则。",
  "yolo.skips": "会自动允许",
  "yolo.skipsList":
    "运行命令（含已配置的 Docker）、读写文件、访问网站和提交表单、搜索服务的首次询问、操作电脑（含截图点击和前台确认）、对外发送、用唯一已保存账号登录。正在等待的审批会重新检查后放行；多个账号未选择时直接提示补充信息。",
  "yolo.keeps": "仍需确认或拒绝",
  "yolo.keepsList":
    "付费生成图片（每次仍弹付费确认卡，除非你在卡上选过「这个 Bot 用这个模型不再问」）；你设成「不允许」的权限；提权命令（如 sudo）；危险操作（仍逐次确认）；工作位置外的写入（仍逐次确认）；不能操作的应用（Pi Bot 自己、钥匙串、密码管理器、终端等）；未授权的局域网和本机地址；受保护的技能和数据目录；只读的参考文件夹。系统权限缺失或平台不支持会直接报告；YOLO 不会代选账号或授予系统权限。",
  "yolo.keepsSafety":
    "命令仍在隔离环境里运行；操作电脑时顶部提示、前台锁、移动鼠标暂停和全局停止快捷键都还在。",
  "yolo.nothingRemembered":
    "YOLO 不会记住任何授权：关掉后马上恢复正常询问，也不会留下「一直允许」。每个自动允许的操作都会写进操作记录。",
  "yolo.unisolated":
    "命令隔离当前不可用（{reason}）。YOLO 不提供隔离保护；命令是否能执行仍按执行设备的确认和权限规则判定。",
  "yolo.unisolatedUnknown": "原因未知",
  "yolo.skipsList.windows":
    "读写工作位置内的文件、访问网站和提交表单、搜索服务的首次询问、操作电脑、对外发送、用唯一已保存账号登录。运行命令是否自动批准取决于「YOLO 自动批准命令（无隔离）」；危险命令仍要逐次确认，提权命令始终拒绝。",
  "yolo.unisolatedEnabled":
    "Windows 命令没有系统隔离。「YOLO 自动批准命令（无隔离）」已开启：普通命令会以你的身份自动运行，可读写你的文件、访问网络；危险命令仍需确认。",
  "yolo.unisolatedDisabled":
    "Windows 命令没有系统隔离。「YOLO 自动批准命令（无隔离）」尚未开启：即使这个对话开了 YOLO，每条命令仍要你确认。",
  "yolo.keepsSafetyUnisolated":
    "命令没有系统隔离保护。操作电脑时顶部提示、前台锁、移动鼠标暂停和全局停止快捷键都还在。",
  "yolo.audit.unisolatedOn": "开启了全局 YOLO 无隔离命令自动批准",
  "yolo.audit.unisolatedOff": "关闭了全局 YOLO 无隔离命令自动批准",
  "yolo.confirm": "开启 YOLO",
  "yolo.failed": "没能切换 YOLO，请重试。",
  "yolo.stepAllowed": "YOLO 自动允许",
  "yolo.stepAllowedDanger": "YOLO 自动允许 · 危险操作",
  "yolo.audit.on": "开启了这个对话的 YOLO",
  "yolo.audit.off": "关闭了这个对话的 YOLO",
  "yolo.audit.allowed": "YOLO 自动允许",
};
export const yoloEn = {
  "yolo.menu": "More",
  "yolo.menuItem": "YOLO mode",
  "yolo.menuOn": "On · click to turn off",
  "yolo.menuOff": "Stop asking for permission in this conversation",
  "yolo.badge": "YOLO · not asking",
  "yolo.badgeHint":
    "YOLO is on in this conversation. Eligible operations are approved automatically; mandatory confirmations and hard refusals still apply.",
  "yolo.turnOff": "Turn off YOLO",
  "yolo.confirmTitle": "Turn on YOLO in this conversation?",
  "yolo.confirmIntro":
    "While it is on, operations that YOLO can approve in this conversation are allowed without asking you. It only affects this conversation: a new topic or conversation starts with it off, and other conversations and routines are not affected.",
  "yolo.confirmGroup":
    "In a group, every member Bot follows the same YOLO rules in this conversation, including its task threads.",
  "yolo.skips": "Allowed without asking",
  "yolo.skipsList":
    "Running commands (including configured Docker), reading and writing files, visiting sites and submitting forms, first-use search prompts, operating the computer (including screenshot clicks and foreground confirmation), sending things out, logging in with a single saved account. Pending approvals are rechecked and released; an ambiguous account choice returns a request for input.",
  "yolo.keeps": "Still asks or refuses",
  "yolo.keepsList":
    'Paid image generation (the paid card still shows unless you chose "Don\'t ask again for this Bot with this model" on it); permissions you set to "Don\'t allow"; privilege escalation (such as sudo); dangerous operations (still ask each time); writes outside working folders (still ask each time); apps that can\'t be operated (Pi Bot itself, the keychain, password managers, terminals and so on); unauthorized local network and loopback addresses; protected skill and data folders; read-only reference folders. Missing system permissions or unsupported platforms are reported directly. YOLO never chooses an account or grants OS permissions.',
  "yolo.keepsSafety":
    "Commands still run isolated. When operating the computer, the top indicator, foreground lock, pause on mouse movement and the global stop shortcut all stay.",
  "yolo.nothingRemembered":
    'YOLO remembers nothing: turning it off asks again right away, and no "Always allow" is left behind. Every operation it allows is written to the activity records.',
  "yolo.unisolated":
    "Command isolation is unavailable ({reason}). YOLO provides no isolation; commands remain subject to the execution device’s confirmation and permission rules.",
  "yolo.unisolatedUnknown": "reason unknown",
  "yolo.skipsList.windows":
    "Reading and writing files in working folders, visiting sites and submitting forms, first-use search prompts, operating the computer, sending things out, and logging in with a single saved account. Command auto-approval depends on “YOLO auto-approves commands (no isolation)”. Dangerous commands still ask each time; privilege escalation is always refused.",
  "yolo.unisolatedEnabled":
    "Windows commands have no system isolation. “YOLO auto-approves commands (no isolation)” is on: ordinary commands run automatically as you and can read and write your files and access the network. Dangerous commands still need confirmation.",
  "yolo.unisolatedDisabled":
    "Windows commands have no system isolation. “YOLO auto-approves commands (no isolation)” is off: every command still needs your confirmation, even with YOLO on in this conversation.",
  "yolo.keepsSafetyUnisolated":
    "Commands have no system isolation. When operating the computer, the top indicator, foreground lock, pause on mouse movement and global stop shortcut remain in place.",
  "yolo.audit.unisolatedOn": "Turned on global YOLO auto-approval for unisolated commands",
  "yolo.audit.unisolatedOff": "Turned off global YOLO auto-approval for unisolated commands",
  "yolo.confirm": "Turn on YOLO",
  "yolo.failed": "Couldn't switch YOLO. Try again.",
  "yolo.stepAllowed": "Allowed by YOLO",
  "yolo.stepAllowedDanger": "Allowed by YOLO · dangerous",
  "yolo.audit.on": "Turned on YOLO for this conversation",
  "yolo.audit.off": "Turned off YOLO for this conversation",
  "yolo.audit.allowed": "Allowed by YOLO",
};
