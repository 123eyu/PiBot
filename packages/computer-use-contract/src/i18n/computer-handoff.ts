// "come help for a moment" card (chat, inbox) and the step it waits on.
// Sentences are per platform: macOS names System Settings / the Dock / desktops, Windows
// Settings / the taskbar / virtual desktops, Linux only "open / restore the window".
export const computerHandoffZh = {
  "computerHandoff.title": "需要你来一下",
  "computerHandoff.waiting": "{name} 在等你",
  "computerHandoff.continue": "我弄好了，继续",
  "computerHandoff.decline": "不用了",
  "computerHandoff.openSettings": "打开系统设置",
  "computerHandoff.openChat": "去对话",
  "computerHandoff.expiresMinutes": "{minutes} 分钟内没处理，这一步就算没做成。",
  "computerHandoff.expiresHours": "{hours} 小时内没处理，这一步就算没做成。",
  "computerHandoff.runWaiting": "等你操作",
  "computerHandoff.inboxTab": "需要你操作",
  "computerHandoff.closed": "这张卡片已经处理过或已失效。",
  "computerHandoff.failed": "没有发出去，请再试一次。",
  "computerHandoff.settingsFailed": "没能打开系统设置，请手动打开。",
  "computerHandoff.result.continued": "你处理好了 · 已继续",
  "computerHandoff.result.declined": "你选择不处理",
  "computerHandoff.result.timeout": "超时，没有处理",
  "computerHandoff.result.cancelled": "运行已停止，这张卡片已取消",
  "computerHandoff.say.accessibility.darwin":
    "请在系统设置 › 隐私与安全性 › 辅助功能里打开 Pi Bot。",
  "computerHandoff.say.accessibility.win32": "请在设置 › 隐私和安全性里允许 Pi Bot 操作电脑。",
  "computerHandoff.say.accessibility.linux": "请在系统设置里允许 Pi Bot 使用辅助功能。",
  "computerHandoff.say.screen_recording.darwin":
    "请在系统设置 › 隐私与安全性 › 屏幕录制里打开 Pi Bot。",
  "computerHandoff.say.screen_recording.win32": "请在设置 › 隐私和安全性里允许 Pi Bot 截取屏幕。",
  "computerHandoff.say.screen_recording.linux": "请在系统设置里允许 Pi Bot 截取屏幕。",
  "computerHandoff.say.screen_recording_not_effective.darwin":
    "屏幕录制权限看起来没生效：请在系统设置里把 Pi Bot 的屏幕录制关掉再打开，然后完全退出并重新打开 Pi Bot。",
  "computerHandoff.say.open_window": "请打开「{app}」的一个窗口。",
  "computerHandoff.say.window_minimized.darwin": "请把「{app}」的窗口从程序坞里恢复出来。",
  "computerHandoff.say.window_minimized.win32": "请把「{app}」的窗口从任务栏里恢复出来。",
  "computerHandoff.say.window_minimized.linux": "请恢复「{app}」的窗口。",
  "computerHandoff.say.window_other_space.darwin":
    "「{app}」的窗口在另一个桌面，或被全屏应用挡住了。请切换到那个桌面，或先退出全屏。",
  "computerHandoff.say.window_other_space.win32": "请把「{app}」的窗口移到你现在用的这个虚拟桌面。",
  "computerHandoff.say.window_other_space.linux": "请恢复「{app}」的窗口。",
  "computerHandoff.say.window_covered": "「{app}」的窗口被其他窗口挡住了，请把它露出来一部分。",
  "computerHandoff.say.window_other.darwin":
    "请确认「{app}」的窗口开着、在这个桌面上、没有最小化。",
  "computerHandoff.say.window_other.win32":
    "请确认「{app}」的窗口开着、在这个虚拟桌面上、没有最小化。",
  "computerHandoff.say.window_other.linux": "请打开或恢复「{app}」的窗口。",
  "computerHandoff.say.retry_limit":
    "{name} 在「{app}」上的「{step}」一直没成功，请看一下屏幕，处理好后点继续。",
  "computerUse.stepHandoff.waiting": "等你操作",
  "computerUse.stepHandoff.continuedDone": "你处理后继续 · 成功",
  "computerUse.stepHandoff.continuedError": "你处理后继续 · 失败",
  "computerUse.stepHandoff.notHandled": "你没有处理",
  "audit.computerHandoff.shown": "请你来处理操作电脑的一步",
  "audit.computerHandoff.continued": "你处理后让 Bot 继续了操作电脑的一步",
  "audit.computerHandoff.declined": "你选择不处理操作电脑的一步",
  "audit.computerHandoff.timeout": "操作电脑的一步等你处理超时",
  "audit.computerHandoff.cancelled": "等你处理的操作电脑步骤已取消",
} as const;

export const computerHandoffEn: Record<keyof typeof computerHandoffZh, string> = {
  "computerHandoff.title": "I need you for a moment",
  "computerHandoff.waiting": "{name} is waiting for you",
  "computerHandoff.continue": "Done, continue",
  "computerHandoff.decline": "No thanks",
  "computerHandoff.openSettings": "Open System Settings",
  "computerHandoff.openChat": "Go to chat",
  "computerHandoff.expiresMinutes":
    "If this isn't handled within {minutes} minutes, the step counts as not done.",
  "computerHandoff.expiresHours":
    "If this isn't handled within {hours} hours, the step counts as not done.",
  "computerHandoff.runWaiting": "Waiting for you",
  "computerHandoff.inboxTab": "Action needed",
  "computerHandoff.closed": "This card was already answered or is no longer valid.",
  "computerHandoff.failed": "That didn't go through. Please try again.",
  "computerHandoff.settingsFailed": "Couldn't open System Settings. Please open it yourself.",
  "computerHandoff.result.continued": "You handled it · continued",
  "computerHandoff.result.declined": "You chose not to handle it",
  "computerHandoff.result.timeout": "Timed out, not handled",
  "computerHandoff.result.cancelled": "The run stopped, so this card was cancelled",
  "computerHandoff.say.accessibility.darwin":
    "Please turn on Pi Bot in System Settings › Privacy & Security › Accessibility.",
  "computerHandoff.say.accessibility.win32":
    "Please allow Pi Bot to operate the computer in Settings › Privacy & security.",
  "computerHandoff.say.accessibility.linux":
    "Please allow Pi Bot to use accessibility in your system settings.",
  "computerHandoff.say.screen_recording.darwin":
    "Please turn on Pi Bot in System Settings › Privacy & Security › Screen Recording.",
  "computerHandoff.say.screen_recording.win32":
    "Please allow Pi Bot to capture the screen in Settings › Privacy & security.",
  "computerHandoff.say.screen_recording.linux":
    "Please allow Pi Bot to capture the screen in your system settings.",
  "computerHandoff.say.screen_recording_not_effective.darwin":
    "Screen Recording doesn't seem to be in effect: in System Settings, turn Screen Recording for Pi Bot off and on again, then quit Pi Bot completely and reopen it.",
  "computerHandoff.say.open_window": "Please open a window of “{app}”.",
  "computerHandoff.say.window_minimized.darwin": "Please restore the “{app}” window from the Dock.",
  "computerHandoff.say.window_minimized.win32":
    "Please restore the “{app}” window from the taskbar.",
  "computerHandoff.say.window_minimized.linux": "Please restore the “{app}” window.",
  "computerHandoff.say.window_other_space.darwin":
    "The “{app}” window is on another desktop or behind a full-screen app. Please switch to that desktop, or exit full screen.",
  "computerHandoff.say.window_other_space.win32":
    "Please move the “{app}” window to the virtual desktop you're using now.",
  "computerHandoff.say.window_other_space.linux": "Please restore the “{app}” window.",
  "computerHandoff.say.window_covered":
    "The “{app}” window is covered by other windows. Please uncover part of it.",
  "computerHandoff.say.window_other.darwin":
    "Please make sure the “{app}” window is open, on this desktop and not minimized.",
  "computerHandoff.say.window_other.win32":
    "Please make sure the “{app}” window is open, on this virtual desktop and not minimized.",
  "computerHandoff.say.window_other.linux": "Please open or restore the “{app}” window.",
  "computerHandoff.say.retry_limit":
    "{name} keeps failing at “{step}” in “{app}”. Please take a look at the screen and continue once it's sorted.",
  "computerUse.stepHandoff.waiting": "Waiting for you",
  "computerUse.stepHandoff.continuedDone": "Continued after you · done",
  "computerUse.stepHandoff.continuedError": "Continued after you · failed",
  "computerUse.stepHandoff.notHandled": "Not handled",
  "audit.computerHandoff.shown": "Asked you to help with a computer step",
  "audit.computerHandoff.continued": "You handled a computer step and let the Bot continue",
  "audit.computerHandoff.declined": "You chose not to handle a computer step",
  "audit.computerHandoff.timeout": "A computer step waiting for you timed out",
  "audit.computerHandoff.cancelled": "A computer step waiting for you was cancelled",
};
