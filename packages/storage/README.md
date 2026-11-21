# @pibot/storage

纯 Node 的存储层，不依赖 Electron，也不访问 pi 的数据目录。

```ts
import { join } from "node:path";
import {
  BotsRepo, ConversationsRepo, MessagesRepo, openDatabase,
  resolveDataDir, runMigrations, SecretStore, SettingsRepo,
} from "@pibot/storage";

const dataDir = resolveDataDir({ platform, env, homedir, dev });
// 由调用方创建数据目录，并在 shutdown 时调用 db.close()。
const db = openDatabase(join(dataDir, "pibot.db"));
runMigrations(db);
const bots = new BotsRepo(db);
const pi = bots.ensureMainBot(systemPrompt);
const settings = new SettingsRepo(db);
const conversations = new ConversationsRepo(db);
const messages = new MessagesRepo(db);
const secrets = new SecretStore(db, cipher, redactor);
```

- `resolveDataDir` 只使用传入的 platform/env/homedir/dev；Windows 路径用 `path.win32`，其他平台用 `path.posix`，模拟平台时也不受宿主平台影响。`PIBOT_DATA_DIR` 优先；APPDATA 缺失时使用 home 下的 AppData/Roaming。不支持的平台抛错。
- `openDatabase` 开启 WAL、外键和 5 秒 busy timeout，返回 `DatabaseSync`，不自动迁移。
- `runMigrations(db, dir?)` 默认从本包 `migrations/` 加载 SQL，按数值版本排序，拒绝重复版本；每个未执行版本及记录在同一个写事务提交。允许跳号（本分支 1/2/3/5），以后补入 0004 也会执行，不按最大版本跳过。打包时需把 SQL 文件复制为资源，并传入资源目录；此包不依赖打包器。
- Settings：`get()` 返回全部设置和默认值，`set(patch)` 校验后原子保存，`remove(key)` 使该项恢复默认。默认值不要求预先写入表。
- Bots：`create/get/list/update/remove`；`ensureMainBot(systemPrompt?)` 只在没有主 Bot 时创建 Pi，保留之后的模型、头像和 persona 修改。默认 prompt 为空，具体中英文 persona 由 brain 注入。
- Conversations：`create({botId, piSessionFile?})/get/list(botId?)/update/remove`；`ensureDm(botId)` 幂等地取或建私聊。外键删除限制遵循规格，需要调用方先删除消息再删除会话/Bot。
- Messages：`MessagesRepo(db,dataDir?)` 的 `create/get/update/remove`；`get/list` 批量合入工具和附件元数据。`list(conversationId, {before?, limit?})` 默认返回最近 50 条，旧消息在前。before 是同一会话中的消息 ID（不含该消息）；不存在或属于其他会话的游标返回空列表。时间相同用 SQLite rowid 保持插入顺序。remove 先拒绝仍有工具外键的消息，再按dataDir清理附件副本；无dataDir不得删除带附件的消息。
- 厂商仓储 ProvidersRepo 已迁至 `@pibot/models/store`，不再由本包导出；厂商 SQL 表的既有迁移仍保留在本包。用法见 `packages/models` 的 `/store` 入口。
- SecretStore：`set/get` 异步；`has/remove/hint` 同步。scope/name 定位（如 `provider:openai` / `apiKey`），get/hint 缺失时返回 undefined。只有写入或实际解密才检查 cipher 可用性，加密失败保留旧值；hint 保存末尾 4 位，短于 8 字符时为 NULL，其余值只存密文。set/get 均登记 redactor，只有 get 更新 last_used_at，并补齐旧数据的 hint；hint 只查数据库，不解密。
- 仓储返回 camelCase 字段；Bot、Message 和 Settings 复用 protocol schema/type。记录 ID 自动生成 UUID v4，时间为 UTC ISO 8601。
- 更新不存在的记录返回 undefined；删除返回是否删除到记录。没有级联删除；业务动作和审计由 brain 在事务里编排。

## 仓储

迁移 `0005_local_exec.sql` 新建六张表及查询索引，Bot 增 `permission_overrides`（默认 `{}`）。
未修改旧迁移，未增加第三方依赖。所有仓储同步，传入同一 `DatabaseSync`；
`transaction(db, operation)` 支持嵌套 SAVEPOINT，可在一个外层事务里组合审批、grant、审计，回调不能是 async。

- `WorkplacesRepo(db, dataDir)`：`list(botId): Workplaces`、`add(botId, path, name?)`、
  `remove(botId, folderId)`、`setCurrent(botId, folderId | "home")`，后三者返回更新后的 Workplaces。
  不访问文件系统；调用方添加前做 realpath，主目录由 dataDir/bots/botId/home 派生。
  同 Bot 同路径幂等，最多 200 个关联文件夹；首个添加成为当前，删当前回主目录，主目录不能删。
- `PermissionsRepo(db)`：`get(): PermissionsSettings`、`set(PermissionsPatch)` 深合并 levels/network、整体替换 pathEntries。
  JSON 存 settings 的 permissions 键，不混进 SettingsRepo；isolation 不落库。
  默认内 read/list=always、write/run/web=ask、未开放四类=never、联网 allowAll=true；
  `OUTSIDE_WORKPLACE_LEVELS` 另给外部 read/list/run=ask、write=never，由 policy 做范围裁决。
  `getBotOverrides(botId)` / `setBotOverrides(botId, overrides)` 操作完整覆盖对象（缺 Bot 返回 undefined）；
  是否比全局更严由 policy/brain 判定，不由存储层自行放宽或代替 policy。
- `GrantsRepo(db)`：`create({botId, category, scope})`、`get(id)`、`list({botId?,before?,limit?}={})`、`revoke(id): boolean`。
  程序集合去重排序，域名小写；list 只返回未撤销授权，revoke 保留原记录，重复撤销返回 false。
- `ToolCallsRepo(db)`：`create({messageId,toolCallId,tool,summary,status?,logPath?})`、`get(id)`、
  `update(id,{summary?,status?,exitCode?,durationMs?,logPath?,finishedAt?})`、`list(messageId,{before?,limit?})`。
  返回 StoredToolCall，额外含仅 brain 使用的 messageId/logPath；`toolRecord()` 去掉这两项。
  `forMessages(messageIds≤200): Map<string,ToolCallRecord[]>` 一次 join 批量取工具/审批；MessagesRepo.get/list 已接入。
  `getLogPath(runId, toolCallId?)` 通过 messages.run_id 找日志；`toolCallId` 指定那一步的日志（一个 run 每条命令一条日志），不带时一个 run 有不同 logPath 就抛错；调用方仍须复核授权路径。
- `ApprovalsRepo(db)`：`create(CreateApproval)`、`get(id)`、`pending({botId?,before?,limit?}={})`、
  `resolve(id,finalStatus,remembered=false): Approval|undefined`；只允许 pending→终态，拒绝过期放行和不合资格 remember。
  **先创建 tool_calls 再创建 approval**：messageId+toolCallId 外键关联，Bot/run 必须与 message 相符，每 Bot 最多一个 pending。
  创建时原子更新 tool_calls.approval_id；同工具再次审批保留全部 approvals，工具历史展示最新审批。
  `finishPending("cancelled"|"expired",{botId?,runId?}={})` 批量取消/恢复，返回数量，不自行发事件或写审计。
- `AuditRepo(db, redactor)`：构造时清理 90 天前记录；`append({botId,kind,summary,detail,runId?})`、
  `list({botId?,kind?,before?,limit?}={})`、`cleanup(now?=new Date()): number`，不提供 update 或单条 delete。
  summary/JSON 字符串叶子先脱敏再落库；detail 只接受协议定义的事实；记录不依赖 Bot 外键，归档/删除后仍保留。
- Grants/Approvals/Audit/ToolCalls 的分页默认 50、最多 200，时间+UUID 倒序；游标必须属于 Bot/类型范围。
  授权撤销或审批结束后，该游标仍能翻到下一页；Message 历史保持原来的正序和消息 ID 游标。
- 工具层负责工具/审批快照脱敏、超时/取消计时器、policy 资格与 grant 写入、审计与事件；仓储不执行系统操作。

直接依赖仅为 `@pibot/protocol-base` 和 `@pibot/secrets`，均锁定 `workspace:0.0.0`；没有新增第三方依赖。
