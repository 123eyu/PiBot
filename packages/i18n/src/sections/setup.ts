// T12 owns welcome and settings additions; both languages share the same keys.
export const setupZh = {
  "setup.discard": "放弃并离开",
  "setup.close": "关闭设置，回到聊天",
  "setup.logsCanceled": "已取消日志导出",
  "setup.loading": "正在加载…",
  "setup.retry": "重试",
  "setup.failed": "操作失败，请重试。",
  "setup.disconnected": "后台服务未连接，请等待重连。",
  "setup.saved": "已保存",
} as const;

export const setupEn: { [K in keyof typeof setupZh]: string } = {
  "setup.discard": "Discard and leave",
  "setup.close": "Close settings and return to chat",
  "setup.logsCanceled": "Log export canceled",
  "setup.loading": "Loading…",
  "setup.retry": "Retry",
  "setup.failed": "Operation failed. Please retry.",
  "setup.disconnected": "The background service is disconnected. Waiting to reconnect.",
  "setup.saved": "Saved",
};
