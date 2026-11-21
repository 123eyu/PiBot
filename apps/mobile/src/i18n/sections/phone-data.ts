// Phone data the computer's Bots can read, and sharing into Pi Bot.
export const phoneDataZh = {
  phoneDataTitle: "电脑可读取的手机数据",
  phoneDataNotificationsGranted: "已获系统授权。Bot 只能读到当前显示在通知栏里的通知。",
  phoneDataNotificationsAsk:
    "打开时会请求安卓「通知使用权」；开关本身不等于已授权。只读当前显示在通知栏里的通知。",
  phoneDataCallsGranted: "已获系统授权。Bot 能读到通话的时间、时长和类型，不含号码或联系人。",
  phoneDataCallsAsk:
    "打开时会请求安卓「通话记录」权限；开关本身不等于已授权。只读时间、时长和类型，不含号码或联系人。",
  phoneDataContractPending:
    "可执行的操作范围尚未确定，暂不开放；系统授权或控制端开关都不会启用它。",
  phoneDataNotifications: "通知监听",
  phoneDataCalls: "通话记录",
  phoneDataAccessibility: "无障碍操作",
  phoneDataShizuku: "Shizuku",
  phoneDataAdapterMissing: "此设备或此版本不支持；系统授权或控制端开关不会启用它。",
  phoneDataEntryHint: "照片和视频、短信验证码；默认都关闭",
  phoneDataLead:
    "这里只设置电脑「{name}」对应的手机本地开关。读取还需控制端开启该能力并完成本次连接确认，以及手机系统授权。Pi Bot 在后台 30 秒后断开；每次读取都记在下面。",
  phoneDataMedia: "照片和视频",
  phoneDataMediaHint: "Bot 可列出拍摄时间、尺寸，查看缩小后的照片或视频封面；不含位置坐标。",
  phoneDataLimited: "iPhone 只开放了部分照片，Bot 只能看到这些。可在系统设置中更改。",
  phoneDataDenied: "系统没有允许 Pi Bot 访问照片，请到系统设置中允许。",
  phoneDataSms: "短信验证码",
  phoneDataSmsHint:
    "收到验证码短信时，系统会先问你是否允许交出这一条；Bot 只拿到验证码和发件号码后四位。",
  phoneDataSmsIos: "iPhone 没有短信接口，Bot 会请你手动输入验证码。",
  phoneDataFallback: "读取最近验证码短信",
  phoneDataFallbackHint:
    "给没有 Google 服务的安卓手机用：需要读取短信权限，只看最近 10 分钟、只取验证码。默认关闭。",
  phoneDataFallbackUnavailable: "这个安装包不含读取短信权限（Google Play 版本）。",
  phoneDataFallbackDenied: "系统没有允许读取短信。",
  phoneDataRecent: "最近被读取",
  phoneDataRecentEmpty: "还没有被读取过",
  phoneDataLogMedia: "照片列表 · {count} 项",
  phoneDataLogMediaGet: "查看照片",
  phoneDataLogSms: "短信验证码",
  phoneDataLogCalls: "通话记录 · {count} 项",
  phoneDataLogNotifications: "通知 · {count} 项",
  phoneDataLogRefused: "未提供",
  phoneDataSaveFailed: "没有保存，请重试",
  phoneDataNoComputer: "先配对一台电脑",
  pushNeedsAppleAccount:
    "iPhone 后台推送需要付费的 Apple 开发者账号（这个版本未开启）；打开 App 时照常提醒",
  shareTitle: "分享到 Pi Bot",
  shareTo: "发送到",
  shareNote: "加一句话（可选）",
  shareSend: "发送",
  shareFiles: "{count} 个文件",
  shareSkipped:
    "{count} 个文件不支持或超过大小上限，已跳过（支持图片、PDF、Office 和文本，单个不超过 20 MB）",
  shareQueued: "已放进发件箱，电脑上线后发出",
  shareSent: "已发送",
  shareNoTopic: "先在联网时打开一次这个对话",
  shareEmpty: "没有可以发送的内容",
  sharePreparing: "正在准备…",
  shareFailed: "没有发出，请重试",
  shareNoChats: "还没有对话",
};
export const phoneDataEn: Record<keyof typeof phoneDataZh, string> = {
  phoneDataTitle: "Phone data this computer can read",
  phoneDataNotificationsGranted:
    "Android access granted. Bots can read only the notifications currently shown.",
  phoneDataNotificationsAsk:
    "Turning this on asks Android for notification access; the switch alone is not a grant. Only notifications currently shown are read.",
  phoneDataCallsGranted:
    "Android access granted. Bots can read the time, length and type of calls, without numbers or contacts.",
  phoneDataCallsAsk:
    "Turning this on asks Android for call log access; the switch alone is not a grant. Only time, length and type are read, without numbers or contacts.",
  phoneDataContractPending:
    "Not available yet: the allowed operations are still being defined. Neither an OS permission nor a control endpoint switch enables it.",
  phoneDataNotifications: "Notifications",
  phoneDataCalls: "Call history",
  phoneDataAccessibility: "Accessibility actions",
  phoneDataShizuku: "Shizuku",
  phoneDataAdapterMissing:
    "Not supported on this device or build; an OS permission or a control endpoint switch will not enable it.",
  phoneDataEntryHint: "Photos and videos, SMS codes; all off by default",
  phoneDataLead:
    "These are local phone switches for “{name}”. Reading also requires the capability to be enabled on the control endpoint, confirmed for this connection, and permitted by the phone system. The link ends 30 seconds after the app leaves the screen. Every read is listed below.",
  phoneDataMedia: "Photos and videos",
  phoneDataMediaHint:
    "Bots can list when and how large items are, and view a downscaled photo or video cover. Never location coordinates.",
  phoneDataLimited:
    "This iPhone shares selected photos only; Bots see just those. Change it in Settings.",
  phoneDataDenied: "Pi Bot is not allowed to access photos. Allow it in system Settings.",
  phoneDataSms: "SMS verification codes",
  phoneDataSmsHint:
    "When a code message arrives, the system asks whether to hand over that one message; Bots get only the code and the sender's last four digits.",
  phoneDataSmsIos: "iPhone has no SMS access; Bots will ask you to type the code.",
  phoneDataFallback: "Read recent code messages",
  phoneDataFallbackHint:
    "For Android phones without Google services: needs the SMS permission, reads only the last 10 minutes and only the code. Off by default.",
  phoneDataFallbackUnavailable: "This build has no SMS permission (Google Play version).",
  phoneDataFallbackDenied: "The system did not allow reading SMS.",
  phoneDataRecent: "Recently read",
  phoneDataRecentEmpty: "Nothing read yet",
  phoneDataLogMedia: "Photo list · {count} items",
  phoneDataLogMediaGet: "Viewed a photo",
  phoneDataLogSms: "SMS code",
  phoneDataLogCalls: "Call history · {count} items",
  phoneDataLogNotifications: "Notifications · {count} items",
  phoneDataLogRefused: "Not provided",
  phoneDataSaveFailed: "Not saved. Try again",
  phoneDataNoComputer: "Pair a computer first",
  pushNeedsAppleAccount:
    "iPhone background push needs a paid Apple developer account (off in this build). Alerts still show while the app is open",
  shareTitle: "Share to Pi Bot",
  shareTo: "Send to",
  shareNote: "Add a note (optional)",
  shareSend: "Send",
  shareFiles: "{count} files",
  shareSkipped:
    "Skipped {count} files that are unsupported or too large (images, PDF, Office and text up to 20 MB each)",
  shareQueued: "In the outbox; sent when the computer is online",
  shareSent: "Sent",
  shareNoTopic: "Open this chat once while online first",
  shareEmpty: "Nothing to send",
  sharePreparing: "Preparing…",
  shareFailed: "Not sent. Try again",
  shareNoChats: "No chats yet",
};
