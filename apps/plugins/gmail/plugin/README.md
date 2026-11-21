# Gmail

## 开源版说明 / Open-source release note

开源版暂不把 Google OAuth 作为 Gmail 的开箱即用登录方式。Gmail 的读取、草稿和修改等权限属于 Google 的敏感或受限权限；面向公众发布前需要完成 Google OAuth 验证，受限权限还可能要求 CASA 安全评估。为避免让用户在未完成审核的应用上授权，开源版只保留本机应用专用密码连接。这个决定是发布合规边界，不代表 Gmail 的本地 IMAP/SMTP 能力被删除。

The open-source release does not offer Google OAuth as a ready-to-use Gmail login for now. Gmail read, draft, and modify permissions are sensitive or restricted scopes; a public release requires Google OAuth verification, and restricted scopes may also require a CASA security assessment. To avoid sending users through an unverified public app, the open-source plugin keeps the local app-password connection only. Gmail's local IMAP/SMTP capability remains available.

支持一种登录方式 / One login mode:

- 应用专用密码 / App password：填写邮箱和 16 位应用专用密码。

应用专用密码只用于本机 IMAP/SMTP 连接，保存在 Pi Bot 的访问令牌中。请在 Google 账号开启两步验证后创建应用专用密码，不要填写普通登录密码。

The app password is used only for the local IMAP/SMTP connection and is stored in Pi Bot's access-token store. Enable 2-Step Verification in Google before creating it; do not enter your normal sign-in password.
