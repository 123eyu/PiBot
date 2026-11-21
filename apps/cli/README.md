# 无头 CLI 与 MCP

这是源码仓库中的开发入口，需要先安装工作区依赖。`run` / `mcp` / `acp --data` 使用独占开发数据目录；这些模式以明文保存凭据，仅用于开发和脚本化检查。`acp` 不带 `--data` 则只连接已运行的桌面 owner，不打开数据库或读取密钥库。

## 启动

```sh
pnpm pibot mcp --data <独占数据目录>
```

只在显式运行命令时提供本机 stdio MCP 服务，不监听网络端口。MCP 客户端应直接启动 `node apps/cli/bin/pibot.mjs mcp --data <目录>`，不要用会在 stdout 输出自身提示的包装脚本。stdout 只承载 JSON-RPC；诊断写 stderr。

可复用无头模式的 `--base-url <http(s)地址> --model <模型ID> [--api <接口格式>]` 配置开发端点；端点密钥只认环境变量 `PIBOT_API_KEY`，不接受命令行密钥。`--context-window <token数>` 登记该模型的上下文窗口，默认128000，范围4096–4000000，只能和 `--base-url` 一起用；填得比模型真实窗口小会过早压缩上下文。`--timeout <秒>` 控制工具工作期限，默认600秒，最多3600秒。首次加载源码也算在工具期限内。

## 两个工具

- `list_bots({ after?, limit? })`：按ID排序，返回 `items: [{id,name,category}]`，可用 `nextAfter` 翻页。默认50项、最多100项；不返回模型凭据、人设或聊天。
- `send_message({ bot, message, newTopic? })`：`bot` 为ID或精确名字，`message` 为非空且不超过100000字符的文字；`newTopic` 默认false。返回 `botId/runId/conversationId/messageId/reply/truncated`，回复最多100000字符，超出时明确标记截断。

发送消息可让 Bot 使用其已有权限执行工具、写文件或对外操作；调用不授予额外权限。所有模型工具继续走原 policy、审批和审计。没有人可以在 stdio 中回答审批卡，因此沿用无头模式的拒绝方式，只处理该次运行自己的卡。多个同时调用明确返回 `busy`，不积压无界队列。

取消请求会停止对应运行；stdin EOF、SIGINT、SIGTERM 会取消在途工作并关闭 brain。工具错误返回固定代码与 `isError`，不透传原异常、参数或密钥。未配置模型时会报错，不自动替换成其他模型。

## 数据所有权与限制

`run` 和 `mcp` 共用 `headless-owner.lock`，同一目录只准一个无头进程。默认桌面目录、别名与有后台 owner 描述符的目录被拒绝；落在受保护目录（凭据目录、`~/.claude` 等其他 agent 配置目录）内的目录也在启动时拒绝，因为命令沙箱读不到其中的 Bot 文件；桌面应用另行启动到自定义路径的竞争仍无法完全识别，必须由调用者保证目录独占。不会打开系统文件选择框、浏览器或电脑驱动。

正常排空后删除锁；启动失败、排空失败或强杀留下的锁不自动抢占。确认旧进程及其工作均已结束后再人工处理遗留锁，不能仅凭PID不存在就删除其他所有者的状态。关闭超过10秒会以错误退出并保留锁。

没有 HTTP MCP 或远程服务发现接口。Windows/Linux 的原生命令和宿主能力限制与无头模式相同，需要对应平台实机验收。

## ACP 接入正在运行的桌面应用

编辑器可运行 `node apps/cli/bin/pibot.mjs acp`，或打包后的 `"/Applications/Pi Bot.app/Contents/MacOS/Pi Bot" --acp`（Linux 同理）。stdout 只传 ACP JSON 帧，接入不会启动 GUI、大脑或另一个数据库写者；执行和审批仍由桌面 Bot 的本机权限负责。initialize 的 clientInfo 可省略或为 null，此时使用 ACP editor / unknown 作为显示信息；显式提供时 name/version 仍严格校验，额外 title 会保留在原始协议帧中。显示信息不代替构建身份校验。

源码 CLI 要先构建同一 checkout 的 desktop，使用它的 version 与 startup-bundle.sha256 校验 owner；没有产物或版本不符返回 `version_mismatch`，不能从 owner 自填身份。未运行返回 `app_not_running`，第二个编辑器返回 `acp_busy`，描述文件权限/属主不符返回 `descriptor_insecure`；应用退出返回 `app_quit`。接入目录按平台默认正式桌面数据路径解析，可用 PIBOT_DATA_DIR 显式覆盖。stdin EOF、SIGINT、SIGTERM 会请求 owner 清理并等待排空回执；不宣称超时就是已清理。macOS 支持，Linux 未实机验证，Windows 明确 `attach_unsupported_platform`。

需要独占开发模式时继续使用 `acp --data <目录>`，可带原 timeout / 模型端点参数；该模式保留原编辑器执行端与目录守卫。
