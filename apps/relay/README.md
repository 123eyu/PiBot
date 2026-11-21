# Pi Bot 中继

> 自建部署和客户端配置的用户文档：[中文](../../docs/guide/zh/15-self-hosting-relay.md) · [English](../../docs/guide/en/15-self-hosting-relay.md)。下面是实现说明（协议合同、限流、部署细节）。

Cloudflare Worker + SQLite类型Durable Object（仅用于免费版DO注册，不读写SQLite/storage）。中继没有账号，不保存消息、凭证、推送token或撤销名单；不写应用日志，关闭observability和Wrangler遥测。WebSocket attachment只随运行时连接保存role/roomId/period，供Hibernation恢复。

## HTTP / WebSocket 合同

- `GET /room/:roomId?credential=…&period=…&role=desktop|phone`：WebSocket升级。roomId为当前UTC日/凭证的哈希承诺；改动凭证/周期403，参数400，未升级426，desktop / 同一runner占用409，限流429。同一房间与周期（即已通过凭证校验）的新phone连接以关闭码4001替换仍为OPEN的旧phone连接（网络切换后的半开连接），并先给desktop发`pibot:offline`再发`pibot:online`；未通过凭证的连接在校验处被拒，碰不到旧连接。
- 每房间最多1个desktop和1个phone；只转发二进制帧，完整帧≤1MiB，超限关闭1009，文本关闭1003。离线时丢弃，不排队、不补发。在线状态文本 `pibot:online` / `pibot:offline`，不作为身份认证。
- `pibot:ping` 自动回复 `pibot:pong`，使用 `acceptWebSocket` / `serializeAttachment` / `setWebSocketAutoResponse`。二进制帧仍须两端Noise认证解密；中继不知道消息内容。
- IP建连60次/分钟；默认Workers Rate Limiting绑定，缺失/异常时回退按IP散列寻址的DO内存计数。推送按roomId每分钟30条，使用同类绑定/内存回退；计数在DO回收后清零，绑定限流属于Cloudflare近似限流，不是持久全局配额。
- `POST /push`，JSON严格仅 `{room:{roomId,credential,period},expoToken,kind,route}`，最多4096字节；kind为approval/run_done/run_failed，route是link生成的加密路由。成功接受Expo返回202，Expo回报DeviceNotRegistered时返回410（桌面据此清除该token），输入400、限流429、上游失败502/请求超时503、未配置secret503。
- Expo上游固定 `https://exp.host/--/api/v2/push/send`，只发通用双语通知和加密route/kind；禁止自定义正文/上游地址。请求10秒期限，EXPO_ACCESS_TOKEN只从Worker secret读取。workerd的fetch只支持manual/follow；使用manual并拒绝非2xx，不向重定向目标转发token。Expo成功接收不等于APNs/FCM送达。

撤销由桌面执行：轮换该手机房间密钥/票据、不再加入旧房间、IK拒绝已撤销公钥。旧手机可占据没有桌面的旧房间，受限流约束；中继不声称拒绝旧房间凭证。每天UTC周期切换由客户端重连；当前周期以外的attachment不再转发。

## 官方与自建部署

官方中继是 `wss://relay.pibot.space`。官方部署由负责人用自己的 Cloudflare 账号/域名运行以下步骤；客户端配置该域名的wss地址。自建部署使用相同步骤，修改wrangler.jsonc的name、需要的自定义域名/路由，保持客户端两端relay一致。

1. 根目录 `pnpm install`，进入 `apps/relay`。使用账号认证后的Wrangler；不把账号token写进仓库。
2. 在Expo项目启用push access-token安全校验，运行 `node tools/wrangler.ts secret put EXPO_ACCESS_TOKEN`，交互输入Expo访问令牌。
3. `pnpm run deploy`。配置中的 `new_sqlite_classes` 适配免费DO计划，不产生应用存储；首次迁移tag为v1，已部署后迁移只追加，不能改旧tag。
4. 如账号不支持Rate Limiting绑定，使用 `node tools/wrangler.ts secret put EXPO_ACCESS_TOKEN --env memory` 与 `pnpm run deploy --env memory`；该环境未配置ratelimits，运行时回退内存计数。默认/备用环境secret分别配置。

本机启动 `pnpm dev`。dev/deploy和本机探针共用`tools/wrangler-env.ts`：显式子进程env强制`WRANGLER_SEND_METRICS=false`，用path.join将XDG_CONFIG_HOME设为仓库`.cache/wrangler/config`、WRANGLER_LOG_PATH设为`.cache/wrangler/logs`，registry随XDG配置目录归仓库；目录已被根.gitignore忽略，不改用户HOME。需要其他Wrangler命令也通过`node tools/wrangler.ts …`运行。手动验收见 `tools/probes/remote/README.md`；测试专用Worker入口和假Expo注入不属于生产部署。不要开启tail/请求体日志或记录含凭证的URL。

Wrangler4.151.3、workers-types5.20261019.1；workerd1.20261019.1脚本精确deny，当前macOS使用平台optional预编译包，不批准postinstall备用下载。云端部署、免费账号实际绑定、强制Hibernation/回收和手机推送送达仍需沙箱外验收。

参考：[Hibernation](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)、[Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、[Expo push](https://docs.expo.dev/push-notifications/sending-notifications/)。
