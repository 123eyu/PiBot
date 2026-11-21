export const runtimeZh = {
  "runtime.drainFailedBot": "会话没能停下来，这个 Bot 会一直显示忙。请重启 Pi Bot 后继续。",
  "runtime.drainFailedGlobal": "有会话没能停下来，Pi Bot 需要重启后才能继续使用。",
  "runtime.auditDrainFailed": "会话排空失败，需要重启",
  "runtime.forceRelease": "强制释放",
  "runtime.forceReleaseConfirm":
    "会中止正在运行的会话，没写完的输出可能丢失。会话如果还是停不下来，就不会被释放，只能重启 Pi Bot。",
  "runtime.forceReleaseFailed": "还是没能确认会话退出，请重启 Pi Bot。",
  "runtime.auditForceRequested": "强制释放：已请求",
  "runtime.auditForceReleased": "强制释放：已释放",
  "runtime.auditForceRefused": "强制释放：未能确认退出",
  "runtime.continuationPrompt": "有未完成的自动接续，是否继续？",
  "runtime.continuationResume": "继续",
  "runtime.continuationDiscard": "放弃",
  "runtime.continuationDropped": "{count} 条没有继续：来源、计划、权限或轮次已经变了。",
  "runtime.continuationKept": "{count} 条在等你回复或审查，没有继续。",
  "runtime.continuationBusy": "这个话题正在回复，等它结束后再点「继续」。",
  "runtime.continuationFailed": "没能继续，请稍后再试。",
  "runtime.auditContinuationResumed": "重启后的自动接续：已继续",
  "runtime.auditContinuationDiscarded": "重启后的自动接续：已放弃",
  "runtime.auditContinuationDropped": "重启后的自动接续：已失效，未继续",
  "runtime.auditContinuationKept": "重启后的自动接续：仍在暂停，未继续",
  "runtime.continuationStopped.round_limit": "自动接续已停止：已达 32 轮上限",
  "runtime.continuationStopped.no_progress": "自动接续已停止：连续两轮没有进展",
  "runtime.continuationStopped.authority_narrowed": "自动接续已停止：来源或权限已经变了",
  "runtime.continuationStopped.restart_dropped": "重启前的自动接续没有继续：条件已经变了",
  "runtime.attachmentDeliveryMissing": "这一轮没有实际发送文件或截图。",
};
export const runtimeEn: Record<keyof typeof runtimeZh, string> = {
  "runtime.drainFailedBot":
    "A session didn't stop, so this Bot will keep showing busy. Restart Pi Bot to continue.",
  "runtime.drainFailedGlobal": "A session didn't stop. Restart Pi Bot before continuing.",
  "runtime.auditDrainFailed": "Session drain failed; restart required",
  "runtime.forceRelease": "Force release",
  "runtime.forceReleaseConfirm":
    "This stops the running session, so unfinished output may be lost. If it still won't stop, nothing is released and only a restart helps.",
  "runtime.forceReleaseFailed": "The session still didn't stop. Restart Pi Bot.",
  "runtime.auditForceRequested": "Force release requested",
  "runtime.auditForceReleased": "Force release: released",
  "runtime.auditForceRefused": "Force release refused: still running",
  "runtime.continuationPrompt": "Some automatic follow-ups didn't finish. Continue them?",
  "runtime.continuationResume": "Continue",
  "runtime.continuationDiscard": "Discard",
  "runtime.continuationDropped":
    "{count} didn't continue: the source, plan, permissions or round budget changed.",
  "runtime.continuationKept":
    "{count} are waiting for your reply or a review, so they didn't continue.",
  "runtime.continuationBusy": "This topic is replying. Choose Continue again once it finishes.",
  "runtime.continuationFailed": "Couldn't continue. Try again in a moment.",
  "runtime.auditContinuationResumed": "Follow-up after restart: continued",
  "runtime.auditContinuationDiscarded": "Follow-up after restart: discarded",
  "runtime.auditContinuationDropped": "Follow-up after restart: no longer valid, not continued",
  "runtime.auditContinuationKept": "Follow-up after restart: still paused, not continued",
  "runtime.continuationStopped.round_limit":
    "Automatic follow-up stopped: reached the 32-round limit",
  "runtime.continuationStopped.no_progress":
    "Automatic follow-up stopped: two rounds in a row made no progress",
  "runtime.continuationStopped.authority_narrowed":
    "Automatic follow-up stopped: the source or permissions changed",
  "runtime.continuationStopped.restart_dropped":
    "The follow-up from before the restart didn't continue: things changed",
  "runtime.attachmentDeliveryMissing": "No file or screenshot was actually sent in this turn.",
};
