# 手机远控桌面能力

入口为 `@pibot/remote/brain`、`/store`、`/ui`，开发夹具只从 `/dev` 显式导入。生产默认装配 @pibot/link 真实适配器；远控仍默认关闭，未启用时不创建长期密钥或中继连接。官方部署地址未配置，用户可填写自建 wss 中继。`kind: development` 的适配器在非开发 brain 被拒绝。

## 接入点

- `src/brain/link/port.ts` 是与连接层的窄合同：identity、pair、connect、push、revoke；本能力不实现 Noise、密码算法或中继帧。真实适配器在 `src/brain/link/adapter.ts`，在 abort 后排空，close/revoke 幂等，onPresence 发布当前状态；Port 必须只传经 pinned public key 认证、解密后的数据。
- remoteCapability 默认创建真实适配器，WebSocket 使用 undici 和内核手动代理 getter，推送复用已安装的网络 fetch；不读环境代理，不在 renderer 或 UI 持有密钥。`brain-app.startBrain({ remote: { link?, host? } })` 仍允许宿主注入可信适配器，desktop runtime 已透传。
- `src/brain/rpc/kernel-bridge.ts` 为能力建立私有回环 Port，手机请求与桌面请求进入同一内核 Peer/handler。两端 ID 加不可冒充的命名空间，出站数据经过内核原脱敏出口后才给 remote。
- 不伪造 GUI 在线：当前 kernel 的 desktopClient(false) 仍会关闭普通交互准入。无 GUI 手机准入需要单独协调最小内核生命周期接口；本批没有绕过此门槛。
- `RemoteHostPort.keepAwake` 要求独立可续租的租约，并在宿主与例行任务租约合并。未注入时拒绝新启用该选项，不直接调用 routines 的单份租约覆盖它。
- 本能力不展示审批卡正文，不依赖 client-core，也不从 desktop 临时深导入纯逻辑。审批事实沿既有 RPC/脱敏事件传输，展示复用不在本能力内。

## 协议与持久化

- `remote-contract` 汇总设备管理、设置、状态、双语表；全局 protocol 登记 schema/事件 envelope。`devices.self`、`remote.session.update` 只在认证手机 gateway 注册，普通桌面调用没有 handler。
- `devices.list({ after?, limit?, includeRevoked? })` 返回公开 DTO/nextAfter，不含公钥、room、push token 或私钥。`revocationPending` 表示本机已拒绝该设备，但中继凭证撤销尚待完成；可用原 id 重试。
- 手机在加密会话调用 `remote.session.update({ foreground, language, pushToken? })`，没有 caller-selected deviceId。pushToken 为 null 删除，省略保留；通知语言随 token 存入 SecretStore。
- 手机 `chat.send` 必须额外传 UUID `clientMessageId`，同一离线消息重连时保持不变，JSON-RPC request id 仍可改变。全局 schema 中该字段为可选，仅手机 gateway 强制要求并去重，桌面原发送行为不变。
- 去重键为 deviceId/clientMessageId，指纹只存私有 SHA-256，不入日志。相同输入成功重试返回原回执；异内容拒绝；pending 或崩溃后的未知结果返回 `remote_message_uncertain`，不能据此重放。
- 迁移 `0070_remote_devices.sql` 追加 settings/devices/receipts 三表。每个设备最多 100000 条发送收据，不自动淘汰以免允许旧请求重放；达到上限明确 busy。最多 32 个活动手机。
- 长期 identity、room secret、push token 分别使用 SecretStore 的 remote-identity、remote-device:<id>、remote-push:<id> scope。设备行 push_token 是 secret 引用，不是 token 明文；撤销先删除公钥/封准入，再排空会话/推送并由 link 退役旧房间密钥，成功才删 room secret。
- 中继变更需要先完成所有设备撤销（包括待清理凭证），避免把旧凭证留在之前的中继。官方实际地址由真实 link 适配器提供，目前没有假设一个已部署地址。

## 边界

- `src/brain/rpc/allowlist.ts` 明列方法/事件（含对话控制：话题切换 / 新建、话题工作位置、执行 / 只规划、计划、改动与撤回、YOLO、插话 / 排队、从这里重试、选择卡、整理上下文、运行信息）。参数另外拒绝附件、图片引用、新话题的目录 / 模式、执行预算、群新话题选目录、重试模型切换与扩展授权参数；电脑/登录/草稿审批要求在桌面处理。另有只读预览：`remote.preview.read`（网关对一次 kernel `preview.read` 切片，`rpc/preview-chunks.ts`）、`office.preview`（`limit` ≤ 50）、`changes.diff` / `changes.lines`（只允许 `scope: "turn"`，`count` ≤ 500）；`preview.open` / `office.open` 不开放。
- `src/brain/rpc/allowlist.ts` 明列方法/事件（含对话控制：话题切换 / 新建、话题工作位置、执行 / 只规划、计划、改动与撤回、YOLO、插话 / 排队、从这里重试、选择卡、整理上下文、运行信息）。参数另外拒绝附件、图片引用、新话题的目录 / 模式、执行预算、群新话题选目录、重试模型切换与扩展授权参数；电脑/登录/草稿审批要求在桌面处理。
- 手机浏览器：`remote.browser.{frame,stop,takeover,input,navigate}` 只在网关处理，交给每个会话一个的 `src/brain/browser/phone-browser.ts`，再经浏览器能力的 `browser.remote` 端口（`ctx.ports`，类型在 `@pibot/browser-contract`）进入桌面同一个浏览器视图服务。帧拉取式、只留最新；点按以帧比例上传并在这里换算成页面坐标；离开页面、`foreground:false`、网关关闭、30 秒无请求时交还接管。`frame` / `input` 不逐条写 `remote.request`（观看起止与接管交还另记）。
- 事件只给手机集合，独立序号缓冲最多 200 条/2 MiB payload；离线不缓存 token delta/工具流，重连补终态后重新取历史。过期游标、大响应返回 resumeUnavailable，不取全局桌面缓冲。
- 每连接 16 个在途请求、内核私有回环 16 个请求，应用明文帧预算 900000 字节，为 link 编码/AEAD 留余量。dispose 不代表已接纳动作被取消，必须等待真实 handler 响应再释放资源。
- 请求审计 `remote.request` 含 actor=phone、deviceId、固定 method/outcome；桌面管理/推送另记 remote.changed。原工具/审批审计和 policy/permit 路径保留，不将 phone 塞进 user/yolo 授权判据。
- 手机断线不自动重发审批/停止/runNow。配对 10 分钟，一次配对；建立配对资源限 20 秒，过期/撤销/关闭时拒绝迟到结果。清理失败保留所有权并阻止正常停机/待命。
- 无后台轮询数据上报；远控默认关闭，开启前确认中继与 Expo 元数据说明。所有 link 错误固定化，不记录 QR、密钥、token、请求正文或 URL 凭证。

## 开发验证

`node --import ./tools/dev/ts-hooks.mjs packages/remote/dev/probe.ts`

该探针仅验证追加迁移、真实仓储、schema Peer 回环、gateway、去重/未知回执、过滤补发、byte budget、审计回调及撤销；无网络/密钥库/模型，也不启动真实 brain。`dev/transport/memory.ts` 仅供隔离探针，没有加密或身份验证，不能作为端到端安全验收。

`node --import ./tools/dev/ts-hooks.mjs packages/remote/dev/acceptance.ts` 通过真实 brain + @pibot/link + 本机 wrangler（经官方关闭遥测的工具入口）+ 假模型/假 Expo 验证配对、列 Bot、流式、允许真实写审批、停止、拒绝审计、推送与撤销。开发只把 wss://relay.invalid 映射到随机 loopback 端口，不放宽生产 URL 校验。无 GUI 生命周期、宿主唤醒租约、系统钥匙串和三平台窗口/休眠仍需后续验收。

## 已完成的 link 对接协议

- 配对 QR 用 link.createPairingPayload/encodePairing，临时房间用 pairingRoom/prologue；手机发 identityProof，桌面验证签名/Noise static 绑定，回 `{ identity: identityProof(...), rotation: base64url(32 bytes) }`，手机验证桌面固定签名公钥后回 `{ paired: true }`。确认后才 commit PSK lease 和持久登记；失败销毁本次会话，不登记设备。
- 双方用 sharedSecret + deriveRoomKey(shared, rotation) 派生长期房间密钥。设备 room 字段是 rotation 引用，SecretStore 中的 roomSecret 是 `{ key, rotation, publicKey }`；实际 ticket/roomId 按 UTC 日生成。长期连接采用 IK，固定被登记的手机 DH 公钥，每次断线/跨日都退休 Peer 并重新握手，不重发 mutation。
- 撤销先在 DB 删除允许公钥，取消并真实关闭旧连接，退役旧 key/rotation 并删除 secret；后续重新配对使用全新随机 rotation/key。中继严格无状态，旧手机可能进入旧空房间，保证是不能再认证桌面或调用 RPC，不能声称中继会拒绝旧 URL。
- /push 只发 ticket、Expo token、固定 kind 和 sealPushRoute 的密文，10秒期限、拒重定向并取消响应体；每个 WebSocket generation 独占 dispatcher，close 等真实 close 事件和 dispatcher 销毁。代理配置切换在下次建连读取；真实代理认证/系统钥匙串行为仍需沙箱外核验。
