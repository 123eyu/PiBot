# @pibot/protocol

纯 TypeScript / Node 包，不依赖 Electron。zod 精确版本为 `4.6.5`。

## 接入

`Methods` 包含 35 个业务方法（基础 20 个 + 附件 2 个 + 本机执行 13 个），`Events` 包含 10 个事件。
`HostMethods` 包含 10 个 brain → main 方法（含附件的 image/pdf/open）；只用在独立 host Port，不能给 renderer 注册这套表。

```ts
import { createPeer, EventBuffer, Events, Methods } from "@pibot/protocol";

// 保留在 brain 生命周期里，换 Port 时仍传入同一个 buffer。
const eventBuffer = new EventBuffer(Events);
const peer = createPeer(port, { methods: Methods, events: Events, eventBuffer });
peer.handle("providers.remove", async ({ providerId }) => {
  await removeProvider(providerId);
  return { ok: true };
});
const off = peer.on("chat.delta", (payload, { seq }) => {
  consumeDelta(payload, seq);
});
await peer.call("app.getInfo", undefined);
off();
peer.dispose();
```

Port 适配器负责把 MessagePort 的 `message.data`（或 Node/Electron 对应的消息值）交给 listener，
以及 start / close / transfer；peer 只调用 `post` 和 `onMessage`，不拥有底层 Port。
`dispose()` 取消订阅、清理 listener / handler / timeout，并拒绝尚未完成的 call。
无参数方法接受 `undefined` 或 `{}`；发送 `undefined` 时省略 `params`。

所有参数、返回值和事件在发出与收到时校验。对象拒绝未定义字段，不静默剥离字段。
`MethodParams` / `MethodResults`、`EventPayloads`、`HostParams` / `HostResults` 是逐项推导出的类型表；
`Params` / `Result` / `Payload` 用于泛型 peer。公共 Bot、Message 等 schema 与类型同样导出。

## 事件与补发

事件是没有 `id` 的 JSON-RPC notification：

```json
{
  "jsonrpc": "2.0",
  "method": "chat.delta",
  "params": {
    "seq": 1,
    "payload": { "runId": "UUID", "messageId": "UUID", "text": "文字增量" }
  }
}
```

- `seq` 从 1 开始，在同一个发送方 buffer 内跨事件名递增。`providers.changed` 的 payload 为 `{}`。
- `on` 的第二个参数提供原始 seq；一个参数的回调仍可直接使用。
- `events.resume({ afterSeq })` 由 peer 内置处理，不能通过 `handle` 覆盖。
- 返回 `EventEnvelope[]`，只包含 `seq > afterSeq` 的事件，按发送顺序排列，保留原 seq 和 payload。
  这是 RPC 返回值，不会再 emit 或自动调用 `on`，不会重新分配 seq。
- renderer 应把返回列表和实时事件按 seq 合并、去重，应用后记录游标。
- 默认仅保留最近 1000 个事件；可用 `new EventBuffer(Events, capacity)` 调整容量。
  超出缓存窗口或游标大于发送方当前 seq 时返回 `-32002`，接入方应重新拉状态 / 历史。
- 替换 peer / Port 时复用原 buffer，才能连续编号并补发断线期间的事件。
  发送失败仍保留事件；原 payload 或返回列表的后续修改不会污染缓存。
  buffer 只在内存中保留，进程退出会丢失；重启后旧游标不适用。

## 数据形状与 host 边界

细节约定：

- Bot / Message 使用数据库表字段的 camelCase；数据库可空字段在 RPC 中显式为 `null`。
  Bot、消息、会话、run 的 ID 为 UUID v4；provider / model 的 ID 为非空字符串。
- `chat.history.before` 是消息 ID 游标；`limit` 是正整数，默认值由 brain 决定。
- `ModelInfo.cost` 为 `{ input, output, cacheRead, cacheWrite }`；`usage` 为 JSON 值。
- `host.secrets.encrypt({ plain }) → Uint8Array`，`decrypt({ cipher }) → string`，
  对应 `SecretCipher` 端口。二进制使用本机 MessagePort 的 structured clone，
  不能直接 JSON.stringify 后当作同一协议传到 WebSocket；将来需要单独的二进制 codec。
- `host.env.detect() → string[]` 只返回变量名；检测哪些变量由 main 根据锁定版本的 pi 决定。
  `host.env.read({ name }) → string | null`，缺失变量用 JSON 的 `null`；
  `BrainHost.env.read` 适配为 `result ?? undefined`。
  调用是否由用户点击「导入」触发由业务层保证。
- `host.openExternal({ url })` 和 `host.setLoginItem({ openAtLogin })` 成功返回 `null`。
  链接只接受 HTTP(S)，允许 localhost。系统操作、safeStorage 可用性检查在 main 实现。
- 密钥拒绝空值、首尾空白、换行与 `!` 前缀；请求头拒绝 `!` 前缀和换行。
  provider 返回信息拒绝额外的明文 Key 字段。存储层仍需独立校验、脱敏。

## 本机执行协议

`src/local-exec.ts` 定义 13 个方法、4 个事件，合入 `Methods` / `Events`；
`EventEnvelopeSchema` 同步支持这些事件。这里只提供契约，handler 由 brain 注册；
未注册 handler 仍返回 `methodNotFound`，不伪装执行成功。新增 host 能力由桌面端提供。

- `Category` 有 9 类（含 `web`），`Level` 为 never/ask/always；`PermissionLevels` 必须包含全部类别。
- `PermissionsSettings` 只含 levels、network、可选 pathEntries；`Permissions` 额外含宿主注入的 isolation。
  `permissions.set` 不接受 isolation；levels/network 可以局部更新，pathEntries 整体替换。
- `Bot.permissionOverrides?` 是类别档位的部分对象，不扩大 `bots.update` RPC；校验时只能收紧全局档位。
- `Workplaces` 为 home/folders/currentId，主目录用字符串 `home` 标识，其余用文件夹 UUID；folders 最大 200。
- `Approval` 含状态与时间、toolCallId（pi 工具 ID 是非空字符串，不强制 UUID）；facts 为
  `{ kind: program|read|write|network|cwd|warning, value: string, risk?: normal|danger }[]`。
  网页事实另有可选 url/domain；resolvedAt 未处理时为 null。
- `Grant.scope` 用 kind 判别：programs（programs + root）、folder（path）、workplace（root）、domain（domain）。
  category 必须与 scope 匹配；域名为规范化的小写 ASCII/punycode，精确匹配，不含 URL/端口/通配符。
- `Message.tools?` 为 `ToolCallRecord[]`；工具状态为 pending/running/done/error/blocked/aborted。
  exitCode/durationMs/finishedAt 可为 null；approval 为可选 `{status, remembered, risk}`，不返回 logPath/完整输出。
- `grants.list` / `approvals.pending` 在 botId 基础上允许可选 before/limit；三类列表（含 audit.list）
  默认 50、最大 200，before 为记录 UUID，倒序按时间再 UUID 消歧，无效/不同筛选范围的游标返回空列表。
- `AuditDetail` 是严格的事实对象，支持审批/命令/路径/域名/字节数/退出结果等字段；不接受 output/content/prompt。
  summary/detail 的实际脱敏与审计落库在 store / brain 完成。

## 错误与生命周期

`RpcError` 提供 `code` / `message`。默认 call 超时 30 秒，可配置 `timeoutMs`。

| code | 含义 |
|---|---|
| -32600 | 非法请求信封 |
| -32601 | 未知方法 / 未注册 handler |
| -32602 | 参数、返回值或事件 schema 校验失败 |
| -32603 | 未预期的 handler 异常（固定消息，不携带异常详情） |
| -32000 | call 超时 |
| -32001 | peer 已 dispose |
| -32002 | 补发游标不可用，需要重新拉状态 |

接收非法事件通知时丢弃；JSON-RPC notification 没有 id，不能回复错误。
发出非法事件时同步抛出 `RpcError(-32602)`；call 的校验失败通过 Promise 拒绝。
业务 handler 可显式抛出 `RpcError`，其 code / message 会发给调用者，必须保证消息可公开。
本包不解析 JSON 文本、不支持 batch；传输层负责解码为单个消息对象。
