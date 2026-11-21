# Pi Bot 手机端

React Native + Expo SDK **58.0.16** / React Native **0.88.0**。页面渲染在 `*Screen.tsx` 和组件里，状态、调用、取消在 `use-*.ts`。

## 当前交付边界

生产入口已接真实 `@pibot/link` 和正式 client-core/tokens，Node 手机逻辑通过本机 Wrangler 中继与假桌面的真实加密演练。远控网关尚未合入此树，完整桌面远控仍待联合验证。独立 `dev/fixture-link.ts` 仅在开发演练中使用，生产入口不引用它。

- `app/`：expo-router 四标签（自绘标签栏）、配对页、`conversation/[kind]/[id]` 聊天页、`approval/[id]` 审批详情。根布局挂 `ApprovalsProvider` 和 `ConversationsProvider`，标签红点、列表、聊天页共用一份数据。
- `src/ui/`：共用组件（图标、Bot 头像、按钮 / chip / 状态标签、底部操作表、toast、页头、标签栏）；颜色只取 `@pibot/ui/tokens`。
- `src/features/chat/controls/`：对话控制，每个控制一个 `use-*.ts`，RPC 序列在 `calls.ts`（纯函数，`probe --controls` 直接调用）。
- `src/runtime/`：实例化运行时、前后台/连接生命周期、设备隔离、固定错误文案；不持有模块级连接或数据库。
- `src/transport/link-port.ts`：已接真实 link 的窄接口。扫码、密钥生成/认证、房间协议由 link 实现；手机只消费已认证 Port。
- `src/transport/session.ts`：用真实 protocol Peer，可信 brain epoch 可用时按 epoch + seq 补事件，缺失时从零恢复，过期重拉；断线退避最长 60 秒。
- `src/storage/`：Expo SQLite 保存设备元数据、历史/列表缓存和待发队列；SecureStore 单独保存每电脑的 opaque credential。
- `src/features/`：聊天分页/流式/工具行/停止，执行任务/群任务/例行运行/续跑，审批事实/记住/危险解锁，设备和扫码。
- `src/push/`：App 内本地通知（`decide.ts` 纯逻辑决定哪些事件提醒、去重、打开中的对话不提醒、文字只有 Bot 名 + 固定短句；`local.ts` 渠道 / 权限 / 展示 / 点按；`NotificationsProvider.tsx` 订阅事件、每台电脑的「通知」开关、按开关登记或清除 Expo 推送 token）。推送路由用房间密钥解开（`transport/push-route.ts`），事件 ID 与本地通知一致，点开只导航到固定页面并重新读取，不执行动作，不接受任意 URL。

普通消息先保存 clientId，再等待有认证的连接。丢失 ACK 保留原 clientId，重连后查验/幂等发送由最终的远控网关接口保证。任务控制和审批离线直接失败，不进入队列。前后台只以真正的 `background` 断连接，系统权限/解锁的短暂 `inactive` 不误中止审批；切电脑或真正后台仍取消等待。结束 native 解锁后重新读取原审批卡，变化/过期拒绝；电脑、登录、外发草稿卡只提示去桌面处理。

本机未落库的配对凭据只保存在运行时私有字段，核对六位安全码后才保存。解除配对取消/排空连接后删除本机密钥、历史、待发队列；电脑端设备记录需在电脑撤销。没有离线审批或自动外发。

## 命令

仓库根目录安装依赖，然后：

```sh
pnpm --filter @pibot/mobile start
pnpm --filter @pibot/mobile typecheck
EXPO_OFFLINE=1 pnpm --filter @pibot/mobile export
pnpm --filter @pibot/mobile probe
pnpm --filter @pibot/mobile probe --relay
pnpm --filter @pibot/mobile probe --controls
pnpm --filter @pibot/mobile probe --notify
pnpm --filter @pibot/mobile probe --phone-data
pnpm check
```

## 电脑可读取的手机数据与分享

- `src/features/phone-data/`：每台配对电脑的开关页（照片和视频、短信验证码、READ_SMS 兜底，默认全关）和「最近被读取」；`serve.ts` 是应答电脑调用的纯逻辑，原生来源在 `*-native.ts`。电脑的调用经 `transport/desktop-calls.ts` 从会话端口分出，只在会话存活（前台或 30 秒后台宽限）时应答。
- `src/features/share/`：`expo-share-intent` 收到分享 → 分享页选 Bot / 群 → 发件箱；文件副本在文档目录 `pibot-share/`，发送时经 `remote.share.upload` 分片上传，再在 `chat.send` 里带 `attachmentIds`。
- `probe --phone-data`：真实 brain + remote 能力 + 脚本化模型调用手机工具，手机端是本 App 的运行时（假相册 / 假短信模块），报告各工具的允许 / 拒绝路径、分享上传、附件限制、审计。

### 安卓本地模块（Kotlin）

`modules/pibot-android/` 是 Expo 本地模块，只做短信验证码：SMS User Consent API（`play-services-auth-api-phone` 18.3.1，不需要短信权限）和可选的 READ_SMS 兜底（最近 10 分钟、只取验证码）。`expo prebuild` 自动链接它并重新生成 `android/`（不提交、不手改）；JS 入口 `modules/pibot-android/index.ts` 在 iOS、Expo Go 或旧包里为空，调用方按「不支持」处理。

```sh
cd apps/mobile
EXPO_NO_TELEMETRY=1 npx expo prebuild --platform android --clean --no-install
cd android && JAVA_HOME=$(/usr/libexec/java_home -v 17) ANDROID_HOME=~/Library/Android/sdk ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

构建开关（`app.config.ts`）：`PIBOT_PLAY_BUILD=1` 去掉 READ_SMS 声明（Google Play 版本）；默认侧载版本带声明，但只有负责人在手机上打开兜底开关并允许系统权限时才会读。iOS 免费 Apple ID 相关的 `PIBOT_IOS_PUSH`、`PIBOT_IOS_SHARE_EXTENSION`、`EXPO_PUBLIC_IOS_APP_GROUP` 见 `docs/ios-build.md`。

Expo 命令通过跨平台 Node 入口设置 `EXPO_NO_TELEMETRY=1`。不加入 Electron 构建。导出在 `apps/mobile/dist`，native iOS/Android 工程由 `expo prebuild` 生成；唯一的手写原生代码是安卓本地模块 `modules/pibot-android/`（Kotlin），不写 Swift。EAS project ID 默认是负责人的 Expo 项目（`app.config.ts`，公开标识，不是凭据），可用 `EXPO_PUBLIC_EAS_PROJECT_ID` / `EAS_PROJECT_ID` 覆盖；安卓推送还要在构建时用 `GOOGLE_SERVICES_JSON` 指向仓库外的 Firebase 配置，没设时设置页如实显示远程推送未设置。完整步骤见 `docs/push-setup.md`。

## 合并后接入位置

1. **link（已接）**：生产由 `src/runtime/context.tsx` 注入 `createMobileLink`，RN 全局 WebSocket + Expo 安全随机数；QR/IKpsk2/身份签名/安全码/房间派生/IK/加密 Port 均使用 `@pibot/link`。`relay-room.ts` 等待原生 socket close 收据，失败保持拒绝栅栏。每日票据边界退役旧连接，由 MobileSession 重握手与恢复事件。开发假实现只在 `src/dev/`。
2. **远控网关接口（待合入）**：`src/transport/remote-peer.ts` 的三份窄 schema 对齐读取到的远控网关实现，合入后改正式 import：`devices.self` 返回 desktopId/desktopName/deviceId/deviceName；发送沿 `chat.send` 增加持久 `clientMessageId`；push 经 `remote.session.update`。`pair-channel.ts` 对齐远控网关的加密身份+rotation / `{ paired: true }` 交换。远控网关当前没有 brain epoch，真实连接不伪造 epoch，重连从 `afterSeq: 0` resume 并重拉；若后续合同提供可信 epoch，再保存该 epoch 的游标。必须重跑真实 remote 网关，假桌面不能证明白名单、审计和持久幂等。
3. **client-core（已接）**：审批事实/双语文案与流式合并直接从正式 `@pibot/client-core` 导入，已删除 alias 和桌面深引用。手机保留自身离线队列/会话薄适配，不直接使用会请求模型目录、图片或附件的桌面控制器，不扩大远程白名单。
4. **tokens（已接）**：直接从 `@pibot/ui/tokens` 取共享主题纯数据，已删除本地快照/生成器与 alias；生成物由共享 ui 的 tokens:check 维护。
5. **i18n 汇总**：新增手机文案暂放 `src/i18n/messages.ts`（双语、TODO 标注），合并后迁入 @pibot/i18n 或 remote-contract；既有审批事实文案和语言解析直接使用 @pibot/i18n。此任务没有修改并行任务拥有的字符串表。
6. **共享边界检查**：由编排者把 mobile 加入 `tools/dev/domain-boundaries.ts` 并合并各分支 lockfile；本任务没有改共享规则文件。mobile 自身的 typecheck 会被根 `pnpm -r typecheck` 收到。

`probe --controls` 用内存 fixture 跑一遍所有聊天控制，fixture 服务端前面挂桌面真实的 `isPhoneMethod` / `restrictPhoneParams`（只有这个 dev 脚本把两个包连起来），输出每个控制调用的方法、白名单外方法 / 参数被拒、离线不排队。

`probe --files` 同样挂真实白名单，并把桌面真实的预览切片器 `packages/remote/src/brain/rpc/preview-chunks.ts` 接到 `remote.preview.read`：跑分块取文件、缓存校验 / 离线 / 解除配对清空、Office 页、运行差异、任务详情、后台同步与预取，报告最大回复字节数和被拒的方法（`preview.open` 等）。

## 依赖和依据

所有直接依赖精确版本；Expo 官方模块覆盖摄像、SecureStore、本机认证、语言、SQLite、CSPRNG 和推送，避免自写原生模块。RN Markdown 用 `react-native-markdown-display@7.0.2`，显式禁 HTML、图片和链接打开；Bot 头像和图标用 `react-native-svg@15.16.0`（SDK 58 配套版本），消息「复制」用 `expo-clipboard@58.0.3`；文件缓存用 `expo-file-system@58.0.10`，保存 / 打开 / 分享用 `expo-media-library@58.0.11`（仅添加相册权限）、`expo-sharing@58.0.19`、`expo-intent-launcher@58.0.3`；Bot 读照片用同一 `expo-media-library`（读取权限只在打开开关时申请）加 `expo-image-manipulator@58.0.15`（缩放 / 转 JPEG）、`expo-video-thumbnails@58.0.2`（视频封面），分享到 Pi Bot 用社区模块 `expo-share-intent@9.0.0`（唯一支持 SDK 58 的版本，带配置插件）；esbuild 仅用于将独立开发探针打包到临时目录，不进入 App。

Expo 的现代 Metro 配置自动识别 pnpm monorepo，以 getDefaultConfig 为基础，仅为 Markdown 的 Node 模块名补上纯 JS `punycode@2.3.1` 解析；没有旧版 watchFolders/nodeModulesPaths 的全局覆盖。React 19.3.0 与主仓一致，React Native 只引入 0.88.0。SDK 自带 structuredClone/DOMException，UUID/getRandomValues 来自 expo-crypto。

参考：[SDK 58](https://expo.dev/changelog/sdk-58)、[monorepo](https://docs.expo.dev/guides/monorepos/)、[SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/)、[notifications](https://docs.expo.dev/versions/latest/sdk/notifications/)。真机、系统权限、相机、Face ID/指纹/密码、后台挂起、APNs/FCM 和真实 relay 仍需沙箱外验收。

真实 link 的本机中继演练：`pnpm --filter @pibot/mobile probe --relay`。只在开发入口把虚拟 wss QR 地址映射到回环 Wrangler；生产不允许 ws/地址重写。演练使用 Node 手机逻辑、真实 link 和 Worker，中英桌面身份为临时合成数据，SecureStore 用内存端口，不能代替原生安全存储或真机验收。

安全码不匹配或本地保存失败时，本机会放弃候选密钥；远控网关在返回电脑 ID 前已登记手机，因此需在桌面撤销该次配对，不能声称本机取消等于桌面撤销。手机“解除配对”在连接排空后删除该电脑的本机 seed/roomKey 及缓存/待发，不向中继发送撤销名单。
