# @pibot/client-core

桌面和手机共用的客户端逻辑。只依赖 `@pibot/protocol` 与 `@pibot/i18n`，不引入 React、DOM 视图、CSS、Electron 或 Node 模块。公共入口是 `@pibot/client-core`。

## 模块与接口

- `chat/`：`ChatController`、按 Peer/话题取得的 `chatController`、`activeRun`、`retryText`、`updateChatBots`、`disposeChatControllers`；`ChatReadCache`、`chatReadCache`、`disposeChatReads`；`appendReplyDelta`、`preserveLiveReply`、`readCurrentTopic`、`readMainBot`。
- `groups/`：`GroupConversation`、`GroupSessionCache`、`readGroupWindow`、`groupRequestError`。目标明确包含 groupId/conversationId/threadId；`start()` 返回注销函数。
- `approvals/`：`approvalText`、`approvalFactText`、`isolationReasonText`、`approvalCountdown`。只展示后端的事实、风险和记住能力，不重新授权。
- `tools/`：`toolNameKey`、`computerToolKey`、`toolTarget`、`displayToolTarget`、`isPlanReadOnly`、`toolGroupSummary`、`toolSteps`、`groupActivity`、`emptyActivity`；共用 ActivityTool/ActivityState 类型。
- `tasks/`：`replyCards`、ReplyCards/ExecutionTopic 类型，按真实工具来源把计划、子任务关联到回复。
- `audit/`（自 desktop `features/audit` 移入）：记录页的文案与分类 `auditSummary`、`auditResult`、`auditGroup`、`auditFilters`、`isInternalAudit`、`auditFactRows`、`safeAuditText`、`routineRunName`/`routineRunStatus` 等；`collapseRepeats(rows, rowId, repeatKey)` 把相邻的相同记录合成一组（×N + 时间范围），桌面与手机共用。
- `rpc/`：ClientPeer、ChatPeer 的类型基础与可取消的 `waitRpc`。传输由应用注入，不创建连接。

两个控制器的 facade 只暴露原有客户端操作，内部 session 持有状态；生命周期、历史、事件、发送、追加回执分别存放。提取保留原方法体、期限、容量、代际和不确定态。

## 生命周期与边界

- Peer 换代前调用 `disposeChatControllers(peer)`，然后释放 Peer；它同时关闭共享读取缓存。单独管理 reads 时使用 `disposeChatReads`。
- `ChatController.subscribe()` 返回注销函数；空闲且无人监听会退役，活动运行仍保留订阅。显式 `dispose()` 取消读取、timer、事件订阅，迟到响应不会回填。
- `GroupConversation.start()` 返回的清理函数负责取消读取、timer、事件订阅和代际；缓存由工作区持有，换 Peer 时 `bindPeer()` 清空旧预览。
- `ChatReadCache` 只合并在途读；展示预览不是权限或发送依据。它不是手机的持久离线消息库。
- 超时只是停止等待，已接纳的发送可能完成。当前 `chat.send` 没有持久客户端幂等 ID；本包不增加重试或离线重发。
- 手机连接、事件游标恢复、离线存储、系统认证和推送属于后续应用层。本次不扩大手机白名单。
- 原桌面 `ChatController` 仍读取 `bots.profile`、`models.list`/`models.images`，并保留图片、附件和追加路径。手机不能直接透传桌面所有能力；需通过薄适配层或拆分后的纯合并/展示函数消费允许的数据。
- 运行时需提供标准的 AbortController/AbortSignal（含 any/timeout/throwIfAborted）、DOMException、performance、queueMicrotask、TextEncoder、structuredClone、crypto.randomUUID 和 timer；Hermes 的缺项由手机入口补齐，不从 Node 或 DOM 视图库引入 polyfill。

## 手机主题数据

从 `@pibot/ui/tokens` 导入 `tokens`，结构为 `{ light, dark }`，键是去掉 `--` 的 CSS token 名，值为解析 `var()` 后的字符串；所有公共、浅色、深色变量均保留。CSS 字体、长度、阴影仍是 CSS 字符串，需要手机视图层按 RN 样式语义适配，不能直接把整个对象当作 RN style。

唯一来源为 `packages/ui/src/theme/tokens.css`。修改后运行 `pnpm --filter @pibot/ui tokens:generate`；`pnpm lint` 调用生成器的 `--check`，字节不一致即失败。这个子路径只加载纯数据，不加载 React DOM 或 CSS。
