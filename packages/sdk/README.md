# @pibot/sdk

Pi Bot 的 TypeScript 客户端。当前是仓库内的私有 L5 包，不发布到 npm。

SDK 不建立配对连接，也不直接打开数据库。调用方把以下任一种已连接对象交给 SDK：

- `apps/cli` 的本机 headless `Peer`：用 `createPiBotClientFromPeer()` 非拥有式包装；
- `@pibot/link` 完成认证后得到的 `Port`：用 `createPiBotClient()` 创建并拥有 Peer。

两种方式都使用 `@pibot/protocol` 汇总的 Methods / Events。RPC 参数、结果和审批事件在 SDK 边界再次经过 zod 校验。不要把未认证的网络传输直接当成 Port。

SDK 的方法集合只是易用接口，不是权限边界：持有 Port 的代码仍可按 protocol 构造其他 RPC。认证 Port 的服务端必须按连接身份实施方法授权或白名单，不能依靠 SDK 没有封装其他 `KernelMethods`。

## 常用接口

```ts
const bots = await client.listBots({ limit: 20 }, { signal });
const sent = await client.sendMessage({ botId: bots[0].id, text: "整理今天的工作" }, { signal });

for await (const event of client.streamRunEvents({ runId: sent.runId, signal })) {
  console.log(event.kind, event.outcome);
}

const pending = await client.listPendingApprovals({ botId: bots[0].id }, { signal });
await client.resolveApproval({ id: pending[0].id, decision: "deny", remember: false });
```

- `listRunEvents()` 是一次有界读取；`streamRunEvents()` 用同一个持久游标轮询，默认每 500ms 读取。brain 会在 session 尾标记、资源收尾和退出修正都落库后追加 `run.sealed`；流完整产出当前页，并且只在读到（或恢复游标已经越过）这个持久水位且追平后结束。`follow: false` 始终返回完整一页。
- 运行事件只公开身份、顺序、种类、时间和终态；数据库中的原始 payload、工具摘要、聊天 / 文件内容与 session entry 不会离开 brain。
- 所有耗时调用都接受 `AbortSignal` 和可选 `timeoutMs`。`client.dispose()` 会取消 SDK 创建的轮询与监听。
- `createPiBotClient()` 拥有 Peer 和 Port，dispose 会关闭它们；`createPiBotClientFromPeer()` 不拥有外部 Peer，CLI 的 brain 与数据目录锁必须由 `headless.stop()` 释放。

## 本机最小脚本

[`examples/local.ts`](examples/local.ts) 包装 `apps/cli` 的 headless Peer，列出一个 Bot、发送一条消息并输出该 run 的持久事件。它会真实调用当前数据目录配置的模型；请使用独立的 CLI 数据目录，不要指向桌面正式数据目录。

```bash
tsx packages/sdk/examples/local.ts /tmp/pibot-sdk-demo "你好"
```

请用调用项目已有的 TypeScript runner 或先编译再运行；SDK 不为这个示例增加运行时依赖。
