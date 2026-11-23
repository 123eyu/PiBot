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
    "普通命令、读写工作位置内的文件、访问网站和提交表单、搜索服务的首次询问、操作电脑、允许自动批准的对外发送、用唯一已保存账号登录。正在等待的审批会重新检查。",
  "yolo.keepsList.windows":
    "危险命令（如删除磁盘根目录或系统文件夹）、网络共享路径、规则判定无法安全分析的命令、写入受保护位置（如 .git、Pi Bot 数据和凭据目录）仍需逐次确认。提权命令（如 runas）始终拒绝。付费生成图片、设为「不允许」的权限和不能操作的应用仍遵循原有规则。",
  "yolo.readOnly.windows":
    "通过读取权限检查的受支持只读命令（如 dir、Get-ChildItem、type）无需开启 YOLO。",
  "yolo.windowsDisclosureTitle": "Windows 没有命令沙箱。",
  "yolo.windowsDisclosure":
    "开启 YOLO 后，普通 Windows 命令会以你的身份直接运行，可以读写你能访问的文件和访问网络。危险命令仍需确认。",
  "yolo.windowsAcknowledge":
    "我知道 Windows 上的命令会直接运行。以后开启 YOLO 时只显示简短提醒，我可以在设置 › 权限撤回同意。",
  "yolo.windowsReminder": "普通 Windows 命令会以你的身份直接运行，危险命令仍需确认。",
  "yolo.windowsConsentSettings": "前往权限设置撤回",
  "yolo.nothingRemembered.windows":
    "关闭 YOLO 后恢复正常询问，开启期间不会留下「一直允许」。每个自动允许的操作都会写进操作记录。",
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
    "Ordinary commands, reading and writing files in working folders, visiting sites and submitting forms, first-use search prompts, operating the computer, eligible outgoing actions, and signing in with a single saved account. Pending approvals are checked again.",
  "yolo.keepsList.windows":
    "Dangerous commands (such as deleting a drive root or system folder), network share paths, commands the policy flags as unparseable, and writes to protected locations (such as .git, Pi Bot data, and credential folders) still ask each time. Elevation (such as runas) is always refused. Paid images, permissions set to Don't allow, and blocked apps still follow their existing rules.",
  "yolo.readOnly.windows":
    "Supported read-only commands (such as dir, Get-ChildItem, and type) can run with YOLO off when their read permissions allow it.",
  "yolo.windowsDisclosureTitle": "Windows has no command sandbox.",
  "yolo.windowsDisclosure":
    "With YOLO on, ordinary Windows commands run directly as you. They can read and write files you can access and use the network. Dangerous commands still ask.",
  "yolo.windowsAcknowledge":
    "I understand that Windows commands run directly. Next time I turn on YOLO, I’ll see a short reminder. I can withdraw consent in Settings › Permissions.",
  "yolo.windowsReminder":
    "Ordinary Windows commands run directly as you. Dangerous commands still ask.",
  "yolo.windowsConsentSettings": "Withdraw in Permissions",
  "yolo.nothingRemembered.windows":
    "Turning off YOLO restores normal prompts. YOLO leaves no Always allow grants. Every automatically allowed action is logged.",
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
