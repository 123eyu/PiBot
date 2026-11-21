# @pibot/link

纯 TypeScript / Uint8Array；运行时代码不使用 node:*、Buffer、DOM。`tsconfig` 的 DOM lib 只为标准 AbortSignal/计时器类型；Hermes 仍需真机验证。依赖 noble curves/ciphers/hashes 精确 2.4.0；protocol-base 提供 Port 与保留控制消息 schema，不反向依赖 link。

## 稳定 API

- `createEndpoint(randomBytes)` / `endpointKeys(seed32)`：Ed25519 身份及同一身份转换的 X25519；`sharedSecret`、`sign/verify`、`safetyCode`；调用者把 seed 存 SecretStore / SecureStore，`destroyEndpoint` 清本对象拥有的私钥副本。
- `createPairingPayload(relay, desktop.signingPublic, name, randomBytes)` → `encodePairing` / `decodePairing`：`pibot-pair:` + base64url 二进制（v1、到期毫秒、Ed25519 公钥、PSK、长度前缀 relay/name、SHA256 校验前8字节）。默认10分钟，解码核到期。校验和只检测损坏，扫码渠道及 Noise 才负责认证。
- `pairingRoom(payload)` 在尚无长期共享秘密时，由 PSK/桌面公钥派生临时房间 ticket；`pairingPrologue(payload)` 绑定本次 QR。
- `NoiseHandshake({role,staticSecret,remoteStatic?,psk?,random,prologue?})`：两消息 IKpsk2 或 IK，算法名 `25519_ChaChaPoly_SHA256`，`write/read/finish/dispose`。`ephemeralSecret` 只供公开向量探针，生产绝不可复用。底层 IK responder 能学习公钥，应用必须核当前已配对名单；上层 `establishNoise` 对无 PSK 会话要求 remoteStatic。
- `NoiseChannel.seal/open/dispose`：线帧为 LE64 序号 + ChaCha20-Poly1305 密文/tag；序号同时作 AAD，发送/接收独立 nonce，严格顺序。线帧最多1 MiB，明文最多 `MAX_PLAINTEXT = 1 MiB - 24`。任何认证/序号错误使 channel 永久退役，每次重连重新握手。
- `identityProof(keys,channel,name)` / `acceptIdentity(value,channel,expectedSigning?)`：握手完成后，通过加密通道交换签名证明（签名绑定握手 hash、名称），复验 Ed25519/X25519 对应。手机同时传 QR 中的 expectedSigning；桌面验手机后才登记长期公钥和接业务 RPC。
- `pairingLease(psk,expiresAt)`：claim 只允许一次并行尝试，commit 在加密的身份确认后消费；任何失败 dispose 并新建 QR。调用者负责期限 timer、信号和持久登记事务，函数不创建后台任务；不得在 IKpsk2 第一消息就认为 PSK 已确认。
- `deriveRoomKey(shared,rotation32)` / `roomTicket(key,period?)`：HKDF-SHA256 派生每手机房间密钥，每 UTC 日 HMAC 派生凭证。roomId 是有域分离的周期/凭证 SHA256 承诺，中继可在不持有房间密钥时验证；`validateRoomTicket` 严格校验当前周期，拒改周期和凭证。rotation 随配对经加密会话交换，撤销时不复用旧 rotation/key。
- `BinaryTransport`：`kind` 标明 relay / direct，`closed` 只表示这条 transport 自身存活，`bufferedAmount()` 供 owner 判断背压；`send` 仍是同步方法。
- `connectRelay({WebSocket,url,signal,onConnect,onPresence,...})`：WebSocket 构造器注入，url 工厂每轮取当前日 ticket，退避1/2/4/.../60秒。onConnect 给新的 relay `BinaryTransport` 和连接信号；调用者重建握手/Peer，不重发 mutation。`confirm()` 在握手完成时重置退避，原始 WebSocket open 不代表设备认证成功。
- `dataChannelTransport(channel,{signal,...})`：注入最小 `DataChannelLike`，每个 message（含 8-byte header）不超过 64 KiB，按 frame id / seq 重组且保持完整帧顺序；逻辑帧仍不超过 1 MiB，待重组总量有界；发送前按 relay 同类规则抽样检查 `bufferedAmount`，不是发送过程中持续保持 2 MiB 硬上限。关闭 / 出错通过 `closed` 传播。
- `negotiateDirect({port,createPeer,role,signal,...})`：只在已有加密 Port 上交换 `link.direct.*` 保留通知；调用者保证每个 Port 同时只有一轮协商。`establishDirectNoise()` 再以设备长期密钥和 `pibot-link-direct-v1` prologue 建立独立 IK 会话。RTC 实现、Peer 切换和回落都留在外层 owner。
- `establishNoise(transport,{...,signal,timeoutMs?})`：10秒握手期限；失败/取消关传输并销毁握手。
- `encryptedPort(channel,transport,{signal,onError?})` → protocol-base Port；`createPeer(port,{methods,events})` 在消费者侧调用。RPC timeout/abort 会经保留的 `rpc.cancel` 消息中止对端处理器的请求级 `AbortSignal`；未知 / 已结束 ID 幂等忽略。取消不证明已派发副作用被回滚，客户端幂等、白名单、设备 actor、事件 resume 均由后续 remote/client 业务层承担。`rpc.stream` 的请求 ID、分块序号、结束标记形状已保留，但当前不发送或交付流式结果。

`randomBytes` 必须由外层注入密码学安全随机源（Node crypto / RN 官方安全随机能力）；库不降级 Math.random。socket 收到的 `pibot:online/offline` 是中继可用性提示，不是对端认证依据。框架回调不得记录 URL、二维码、PSK、密钥、ticket 或消息正文。

## 中继与业务边界

`@pibot/link/room` 单独导出 RoomTicket、派生/承诺校验、PushRequest 的严格解析，以及 `sealPushRoute(key,id,random)` / `openPushRoute(key,route)`。推送路由用独立域派生密钥、随机96位nonce的ChaCha20-Poly1305；中继不解密。

按2026-10-21决定，中继不持久化数据，也不维护撤销名单。桌面撤销时销毁旧连接、轮换该手机roomKey/rotation，并从当前Noise允许名单移除公钥；不得继续加入旧房间。旧凭证可加入旧的空房间，不代表撤销失效。每天周期切换须由上层主动关连接、取新ticket并重握手；url工厂本身不创建轮换定时器。

权限判定、设备撤销事务、审计、业务RPC白名单与迁移属于remote能力包；link认证设备身份，不授予工具权限。断线后新建Peer，原调用可能已经执行，不能自动重发写操作。谁创建谁释放channel、transport、Peer和连接定时器。

Noise 对照来源：[官方 revision 34](https://noiseprotocol.org/noise.html)、[cacophony 公开向量](https://github.com/haskell-cryptography/cacophony/blob/master/vectors/cacophony.txt)。公开向量仅保留本算法两组，见 tools/probes/remote/noise-vectors.json；未复制其实现代码。
