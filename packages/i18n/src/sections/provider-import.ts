export const providerImportZh = {
  "providerImport.title": "从 {name} 切换模型？",
  "providerImport.intro":
    "外部链接请求更改 Pi Bot 使用的模型。切换后，所选 Bot 的请求会发往下方地址。",
  "providerImport.changes": "会改什么",
  "providerImport.provider": "厂商",
  "providerImport.address": "地址",
  "providerImport.model": "模型",
  "providerImport.key": "密钥",
  "providerImport.keyIncluded": "链接含密钥，将加密保存",
  "providerImport.noKey": "链接不含密钥",
  "providerImport.applyTo": "应用到",
  "providerImport.selectionNote": "点击 Bot 可取消或恢复选中。未选中的 Bot 会继续使用原模型。",
  "providerImport.auditNote": "切换会写入审计记录。可以在对应 Bot 的资料页换回原模型。",
  "providerImport.switch": "切换",
  "providerImport.refused": "已拒绝模型切换",
  "providerImport.refusedNote":
    "此链接无效、无法用于当前 Bot，或包含不受支持的地址。仅接受 HTTPS、本机或局域网 HTTP。",
  "providerImport.failed": "未能完成切换。请重新从来源应用打开链接后再试。",
  "providerImport.ok": "确定",
  "audit.providerImport.applied": "已通过链接切换 Bot 模型",
} as const;

export const providerImportEn: Record<keyof typeof providerImportZh, string> = {
  "providerImport.title": "Switch models from {name}?",
  "providerImport.intro":
    "An external link is asking to change the model Pi Bot uses. Selected Bots will send requests to the address below.",
  "providerImport.changes": "What changes",
  "providerImport.provider": "Provider",
  "providerImport.address": "Address",
  "providerImport.model": "Model",
  "providerImport.key": "API key",
  "providerImport.keyIncluded": "Included in the link and saved encrypted",
  "providerImport.noKey": "The link has no key",
  "providerImport.applyTo": "Apply to",
  "providerImport.selectionNote":
    "Click a Bot to change its selection. Unselected Bots keep their current models.",
  "providerImport.auditNote":
    "Pi Bot records the switch in the audit log. You can restore each Bot's model from its profile.",
  "providerImport.switch": "Switch",
  "providerImport.refused": "Model switch refused",
  "providerImport.refusedNote":
    "This link is invalid, cannot be used with the current Bots, or contains an unsupported address. Use HTTPS, or HTTP on this device or the local network.",
  "providerImport.failed":
    "The switch could not be completed. Reopen the link from the source app to try again.",
  "providerImport.ok": "OK",
  "audit.providerImport.applied": "Bot models switched from a provider link",
};
