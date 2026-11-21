// The always-on-top indicator shown while a Bot operates the computer.
export const computerGuardZh = {
  "computerGuard.title": "Pi Bot 正在操作电脑",
  "computerGuard.background": "{bot}正在操作 {apps} · 后台进行，不占你的鼠标",
  "computerGuard.foreground": "{bot}正在前台操作 {apps} · {step}",
  "computerGuard.waiting": "{bot}在等待前台 · {step}",
  "computerGuard.pausedUser": "{bot}已暂停 · {apps}",
  "computerGuard.pausedActivity": "你动了鼠标，{bot}已暂停 · 3 秒没动就继续",
  "computerGuard.pausedLocked": "屏幕已锁定，{bot}等你解锁后再继续",
  "computerGuard.confirm": "{bot}要在前台{action}",
  "computerGuard.allow": "允许",
  "computerGuard.skip": "跳过",
  "computerGuard.pause": "暂停",
  "computerGuard.resume": "继续",
  "computerGuard.stop": "停止",
  "computerGuard.stopHint": "{key} 全部停止",
} as const;

export const computerGuardEn = {
  "computerGuard.title": "Pi Bot is operating the computer",
  "computerGuard.background": "{bot} is operating {apps} · in the background, not using your mouse",
  "computerGuard.foreground": "{bot} is using the foreground in {apps} · {step}",
  "computerGuard.waiting": "{bot} is waiting for the foreground · {step}",
  "computerGuard.pausedUser": "{bot} is paused · {apps}",
  "computerGuard.pausedActivity":
    "You moved the mouse, {bot} paused · continues after 3 idle seconds",
  "computerGuard.pausedLocked": "Screen locked, {bot} continues after you unlock",
  "computerGuard.confirm": "{bot} wants to use the foreground: {action}",
  "computerGuard.allow": "Allow",
  "computerGuard.skip": "Skip",
  "computerGuard.pause": "Pause",
  "computerGuard.resume": "Resume",
  "computerGuard.stop": "Stop",
  "computerGuard.stopHint": "{key} stops all",
} as const;
