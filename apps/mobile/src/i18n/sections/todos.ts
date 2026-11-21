// To-dos tab (maintainers 2026-11-20). Colour, sticker and editor labels shared with the desktop
// come from @pibot/i18n (personalTodos.*).
export const todosZh = {
  todos: "待办",
  todoDayCount: "{date} · {count} 项",
  todoUndated: "未定日期 · {count} 项",
  todoUnsynced: "未同步",
  todoEmptyMonth: "这个月还没有待办。点 ＋ 在选中的那天新建一条。",
  todoOffline: "电脑离线，显示的是上次同步的待办。你的修改会先存在手机上，电脑上线后按顺序同步。",
  todoNeverSynced: "还没有从这台电脑同步过待办，电脑上线后会自动同步。",
  todoDroppedChanged:
    "{count} 条手机上的修改没有同步：电脑上之后又改过这些待办，已保留电脑上的版本。",
  todoDroppedFailed: "{count} 条手机上的修改电脑没有接受，已放弃。",
  todoQueueFull: "等待同步的修改太多了，请等电脑上线同步后再改。",
  todoNoDate: "不定日期",
  todoTimeHint: "如 09:30",
  todoTimeInvalid: "时间请写成 09:30 这样的格式。",
  todoNoEnd: "无",
  todoClear: "清除",
  todoSyncedAt: "上次同步 {time}",
  todosFoot: "和电脑上的「个人待办」是同一份。日期不会自动创建日历提醒。",
} as const;
export const todosEn: Record<keyof typeof todosZh, string> = {
  todos: "To-dos",
  todoDayCount: "{date} · {count}",
  todoUndated: "No date · {count}",
  todoUnsynced: "Not synced yet",
  todoEmptyMonth: "No to-dos this month. Tap + to add one on the selected day.",
  todoOffline:
    "Computer offline. Showing the last synced to-dos. Your changes stay on the phone and sync in order when it is back online.",
  todoNeverSynced:
    "To-dos have not been synced from this computer yet. They sync once it is online.",
  todoDroppedChanged:
    "{count} change(s) made on the phone were not synced: the to-do changed on the computer afterwards, so the computer's version was kept.",
  todoDroppedFailed:
    "{count} change(s) made on the phone were refused by the computer and dropped.",
  todoQueueFull: "Too many changes are waiting to sync. Wait until the computer is online.",
  todoNoDate: "No date",
  todoTimeHint: "e.g. 09:30",
  todoTimeInvalid: "Write the time like 09:30.",
  todoNoEnd: "None",
  todoClear: "Clear",
  todoSyncedAt: "Last synced {time}",
  todosFoot:
    "The same list as Personal to-dos on the computer. Dates do not create calendar reminders.",
};
