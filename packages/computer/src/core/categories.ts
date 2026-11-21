/**
 * Category hints for the blocklist's default ticks: chat apps and mail
 * clients are suggested, never forced. Matching is by OS app id or display name, lower-case.
 */
const CHAT = [
  "com.tencent.xinwechat",
  "wechat",
  "微信",
  "weixin.exe",
  "wechat.exe",
  "com.tencent.qq",
  "qq",
  "qq.exe",
  "ru.keepcoder.telegram",
  "org.telegram.desktop",
  "telegram",
  "telegram.exe",
  "net.whatsapp.whatsapp",
  "whatsapp",
  "whatsapp.exe",
  "com.tinyspeck.slackmacgap",
  "slack",
  "slack.exe",
  "com.hnc.discord",
  "discord",
  "discord.exe",
  "com.electron.lark",
  "com.bytedance.lark",
  "飞书",
  "lark",
  "feishu.exe",
  "com.alibaba.dingtalkmac",
  "钉钉",
  "dingtalk",
  "dingtalk.exe",
  "com.apple.mobilesms",
  "messages",
  "信息",
  "com.microsoft.teams2",
  "com.microsoft.teams",
  "microsoft teams",
  "ms-teams.exe",
  "org.whispersystems.signal-desktop",
  "signal",
  "signal.exe",
  "jp.naver.line.mac",
  "line",
  "line.exe",
  "com.skype.skype",
  "skype",
  "com.tencent.wework",
  "企业微信",
  "wxwork.exe",
];
const MAIL = [
  "com.apple.mail",
  "mail",
  "邮件",
  "com.microsoft.outlook",
  "microsoft outlook",
  "outlook.exe",
  "olk.exe",
  "com.readdle.smartemail-mac",
  "spark",
  "it.bloop.airmail2",
  "airmail",
  "org.mozilla.thunderbird",
  "thunderbird",
  "thunderbird.exe",
  "com.foxmail.foxmail",
  "foxmail",
  "foxmail.exe",
  "com.netease.mailmaster",
  "网易邮箱大师",
  "mailmaster.exe",
  "org.gnome.evolution",
  "evolution",
  "geary",
  "org.gnome.geary",
];
const CHAT_SET = new Set(CHAT);
const MAIL_SET = new Set(MAIL);

export function categoryHint(app: {
  id: string;
  name: string;
  osCategory?: string;
}): "chat" | "mail" | undefined {
  const keys = [app.id.toLowerCase(), app.name.toLowerCase()];
  if (keys.some((k) => CHAT_SET.has(k))) return "chat";
  if (keys.some((k) => MAIL_SET.has(k))) return "mail";
  if (app.osCategory === "public.app-category.social-networking") return "chat";
  return undefined;
}
