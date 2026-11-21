import { connectorResultCount } from "@pibot/protocol-base";

export type LocalAppConnection = "contacts" | "calendar";
export const localAppNextStep = (app: LocalAppConnection) =>
  app === "contacts"
    ? "请核对姓名、电话、邮箱或公司后再查；macOS 在「系统设置 › 隐私与安全性 › 通讯录」允许 Pi Bot，Windows 需要已配置的经典 Outlook（新版不支持）。不要改用操作电脑点击通讯录 App；只有用户明确要求操作 App 才可使用，且仍需原权限。 / Check the name, phone, email or company before searching again. On macOS enable Pi Bot in System Settings > Privacy & Security > Contacts; Windows requires configured classic Outlook (not new Outlook). Do not switch to computer tools to click Contacts unless the user explicitly requests operating the app; normal permissions still apply."
    : "请核对日期范围和日历选择；macOS 在「系统设置 › 隐私与安全性 › 日历」允许 Pi Bot，Windows 需要已配置的经典 Outlook（新版不支持）。不要改用操作电脑点击日历 App；只有用户明确要求操作 App 才可使用，且仍需原权限。 / Check the date range and calendar selection. On macOS enable Pi Bot in System Settings > Privacy & Security > Calendars; Windows requires configured classic Outlook (not new Outlook). Do not switch to computer tools to click Calendar unless the user explicitly requests operating the app; normal permissions still apply.";

export function localAppFailure(app: LocalAppConnection, code: string) {
  const reasons: Record<string, string> = {
    cancelled: "读取已取消，结果未知 / Read cancelled; result unknown",
    permission_required: "系统尚未允许读取 / System access has not been granted",
    read_failed: "系统读取失败，未取得可靠结果 / System read failed; no reliable result obtained",
    dependency_missing: "系统依赖不可用 / System dependency unavailable",
    outlook_missing: "经典 Outlook 不可用 / Classic Outlook unavailable",
    outlook_access_denied: "Outlook 拒绝访问 / Outlook access denied",
    contacts_unavailable:
      "系统没有向 Pi Bot 提供任何通讯录账户，可能是沙箱或系统权限问题，请导出日志 / The system provided no contacts accounts to Pi Bot. This may be a sandbox or system permission issue; export the logs",
    contact_scan_limit:
      "通讯录超出单次扫描上限；当前搜索从头枚举，缩短查询不能保证减少扫描，请导出日志并等待范围检索支持 / Contact scan limit reached. Searches currently enumerate from the beginning, so narrowing the query may not reduce scanning; export logs and wait for scoped search support",
  };
  return `${reasons[code] ?? "连接调用失败，未取得可靠结果 / Connection call failed; no reliable result obtained"}。${localAppNextStep(app)}`;
}

/** Only a known zero count means no matches; an unrecognised or truncated payload is unknown. */
export function localAppEmptyHint(value: unknown, app: string | undefined) {
  return (app === "contacts" || app === "calendar") && connectorResultCount(value) === 0
    ? `\n未找到匹配项（不表示没有联系人或日程） / No matches (not proof that no contacts or events exist). ${localAppNextStep(app)}`
    : "";
}
