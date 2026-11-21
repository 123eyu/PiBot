export const teamsZh = {
  "teams.localOmitted": "未包含：{name}（本地导入、超过导出上限）。请取得原文件后重新导入。",
  "teams.sourceRequired": "{name}：这个技能需要从来源重新导入；模板未包含技能文件。",
  "teams.sourcePrepare": "确认从来源下载并预览",
  "teams.sourceReview":
    "来源内容不可信。将导入 {files} 个文件、{bytes} 字节；请检查正文。不会自动运行脚本，也不恢复任何权限。",
  "teams.sourceConfirm": "确认导入这个技能",
  "teams.sourceImported": "技能已导入。",
  "teams.sourceUnavailable": "链接导入能力尚不可用。来源已保留，请在链接导入可用后重试。",
  "teams.sourceFailed": "未完成来源导入。请检查来源，重新预览后再试。",

  "teams.moreMenu": "更多",
  "teams.backMenu": "返回菜单",
  "teams.saveCancelled": "已取消保存。",
  "teams.exportBotNote":
    "只导出 Bot 的资料、头像、权限设置和技能；不包含聊天、记忆、密钥或工作文件。",
  "teams.exportNote":
    "分享成员 Bot 的人设、工作规范、头像、模型偏好、权限收紧项和技能（含脚本），以及群规则；不含密钥、聊天、记忆、保存的账号密码或文件夹路径。",
  "teams.exportFailed": "模板未保存。请检查模板或保存位置后重试。",
  "teams.choose": "选择 .pibot 文件",
  "teams.professionsNote": "没有文件也行：按职业挑一组现成的 Bot 和群聊",
  "teams.chooseAgain": "重新选文件",
  "teams.confirm": "确认导入",
  "teams.empty": "选择同事分享的模板，预览后再创建 Bot 和群聊。",
  "teams.picking": "正在等待选文件并读取预览…",
  "teams.provenanceOfficial": "官方已验证：文件匹配已签名角色库。",
  "teams.provenanceUnverified": "未验证来源：文件不在已签名角色库中。请检查权限、技能和命令策略。",
  "teams.review": "请完整查看人设。导入后它会成为 Bot 的系统提示词；现在不会运行其中的指令。",
  "teams.permissions":
    "导入的 Bot 从本机的全局默认权限开始，只接受比默认更严的设置（下面列出了没采用的项）。不导入密钥、聊天、记忆、文件夹或已记住的授权，工作区与系统边界仍适用。",
  "teams.count": "将创建 {bots} 个 Bot、{groups} 个群聊",
  "teams.preferred": "模板模型偏好",
  "teams.resolved": "导入时使用",
  "teams.noPreference": "未指定",
  "teams.fallback": "偏好模型在本机不可用，已映射到默认可用模型。",
  "teams.noModel": "尚无可用模型",
  "teams.noModelNote": "仍可导入；聊天前请在资料面板选择一个已配置模型。",
  "teams.noDescription": "没有工作描述",
  "teams.emptyPersona": "空人设",
  "teams.noAnnouncement": "没有群公告",
  "teams.members": "成员",
  "teams.rounds": "自动来回上限：{count} 次",
  "teams.expired": "预览已过期或已使用，请重新选择文件。",
  "teams.readFailed": "无法预览。请确认文件是有效的 .pibot 文件且不超过 20 MB，再重新选择。",
  "teams.importFailed": "导入未完成，数据已回滚。有效期内可重试这份预览。",
  "teams.uncertain": "导入结果尚未确认。请关闭预览并查看会话列表，避免重复导入。",
  "teams.busy": "另一个文件操作尚未结束，请关闭系统文件框后重试。",
  "teams.importedPartly": "导入完成，但下面这些技能没导入：",
  "teams.skippedSkill": "「{skill}」（{bot}）",
  "teams.skippedHint": "可以之后在 Bot 的资料面板里重新添加这些技能。",
  "teams.done": "知道了",
} as const;
export const teamsEn: Record<keyof typeof teamsZh, string> = {
  "teams.localOmitted":
    "Not included: {name} (local import, exceeds the export limit). Obtain the original files and import them again.",
  "teams.sourceRequired":
    "{name}: this skill needs to be imported again from its source. The template contains no skill files.",
  "teams.sourcePrepare": "Confirm source download and preview",
  "teams.sourceReview":
    "Source content is untrusted. Importing {files} files, {bytes} bytes. Review the text. Scripts will not run automatically and no permissions are restored.",
  "teams.sourceConfirm": "Confirm skill import",
  "teams.sourceImported": "Skill imported.",
  "teams.sourceUnavailable":
    "Link import is not available yet. The source is retained; retry when link import is available.",
  "teams.sourceFailed":
    "Source import did not finish. Check the source and preview it again before retrying.",

  "teams.moreMenu": "More",
  "teams.backMenu": "Back to menu",
  "teams.saveCancelled": "Save cancelled.",
  "teams.exportBotNote":
    "Exports the Bot profile, avatar, permissions and skills; excludes chats, memories, secrets and working files.",
  "teams.exportNote":
    "Shares the member Bots’ personas, working norms, avatars, model preferences, tightened permissions and skills (scripts included), plus group rules. Keys, chats, memories, saved passwords and folder paths are excluded.",
  "teams.exportFailed": "The template was not saved. Check the template or destination and retry.",
  "teams.choose": "Choose a .pibot file",
  "teams.professionsNote": "No file? Pick a ready-made set of Bots and groups by profession",
  "teams.chooseAgain": "Choose another file",
  "teams.confirm": "Confirm import",
  "teams.empty": "Choose a shared template and review it before creating Bots and groups.",
  "teams.picking": "Waiting for file selection and loading the preview…",
  "teams.provenanceOfficial": "Officially verified: this file matches the signed role library.",
  "teams.provenanceUnverified":
    "Unverified source: this file is not in the signed role library. Review permissions, skills and command policy.",
  "teams.review":
    "Read the entire persona. It becomes the Bot’s system prompt after import; its instructions will not run during this preview.",
  "teams.permissions":
    "Imported Bots start from this computer’s global default permissions and only take settings stricter than them (items not applied are listed below). Keys, chats, memories, folders and remembered grants are excluded; workspace and system boundaries still apply.",
  "teams.count": "Creates {bots} Bots and {groups} groups",
  "teams.preferred": "Preferred model",
  "teams.resolved": "Model used on import",
  "teams.noPreference": "Unspecified",
  "teams.fallback":
    "The preferred model is unavailable here and has been mapped to the default available model.",
  "teams.noModel": "No available model",
  "teams.noModelNote":
    "You can still import. Choose a configured model in the profile panel before chatting.",
  "teams.noDescription": "No job description",
  "teams.emptyPersona": "Empty persona",
  "teams.noAnnouncement": "No announcement",
  "teams.members": "Members",
  "teams.rounds": "Automatic round limit: {count}",
  "teams.expired": "This preview expired or was already used. Choose the file again.",
  "teams.readFailed": "Unable to preview. Choose a valid .pibot file no larger than 20 MB.",
  "teams.importFailed":
    "Import failed and the changes were rolled back. You can retry this preview before it expires.",
  "teams.uncertain":
    "The import result is unconfirmed. Close the preview and check your chat list before importing again.",
  "teams.busy": "Another file operation is still active. Close the system dialog and retry.",
  "teams.importedPartly": "Imported, but these skills were not added:",
  "teams.skippedSkill": "“{skill}” ({bot})",
  "teams.skippedHint": "You can add them again later from the Bot’s profile panel.",
  "teams.done": "Got it",
};
