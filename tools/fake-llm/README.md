# 本地假模型与聊天 / 例行任务无窗口演练

本目录复用原有 OpenAI SSE / Ollama NDJSON 服务，不加载 Electron，不调用真实模型。
聊天演练结果是纯 Node 脚本化链路证据；窗口、系统文件框、钥匙串、SRT 和真实厂商仍须负责人验收。

例行任务：`pnpm acceptance:routines` 每次加载当前工作区的真实brain、锁定pi SDK与本机HTTP模型，用独立临时SQLite/文件/native watcher先演练原13场景，再用新Worker跑暂停到期folder回归，合14行。两个Worker分别5分钟上限、真实exit后清根，全部成功才打印；可用 `node tests/e2e/routines/index.ts pause-folders` 单跑新回归。覆盖真实写/唯一闸门、held/parked/聊天与自动群、旧owner退出恢复、missed/暂停/away、托盘适配/dev边界；停启断言必须新run恰加1/新文件/真实模型事实，不能拿旧终态充通过。fetch/Socket限fixture并计数，结果只含结构统计；不操作用户当前应用、账号或电源，Electron/OS端口替身不代表实机验收。

`pnpm build && pnpm acceptance:routines:artifacts` 核对生产dev handler消除、13迁移字节、当前平台rg/两个WASM资源、精确运行依赖及打包配置；资源准备仅写build out，不签名或启动应用。完整安装包由root合并后用 `PIBOT_SIGN_IDENTITY=adhoc pnpm app:package` 另验。这两个入口不是Vitest单元测试。

## 运行入口

先使用 `.nvmrc` 的 Node 26.11.1 和 pnpm 12，冻结安装依赖，然后执行：

```sh
pnpm acceptance:chat
pnpm acceptance:chat compaction
```

第一条逐场景串行运行；第二条只运行指定场景（`collaboration` 包括完整协作和上限 2 两项）。
每项建立独立临时目录、应用当前全部迁移的 SQLite、内存 Port 和随机端口服务；模板导出和导入使用两个先后释放的独立目录。
入口先移除环境中的认证配置，只保留 PATH/临时目录/Windows 系统目录；假 SecretCipher 仅服务合成凭据，不验证加密或 safeStorage。
Bot UUID 由真实仓储生成，再经 RPC 显式命名和设置模型；工作位置全部关联临时根。
`fetch` 只允许该项的精确 `127.0.0.1:随机端口`，禁重定向；其他 fetch 尝试直接失败。
输出只有场景、请求计数、结论和窗口未验证状态，不输出凭据、prompt、工具参数或聊天正文。
全部场景在独立 Worker 内串行执行，每项先等 brain 真正 stop/drain，再释放 peer、关闭服务及日志。
主线程 `tests/e2e/supervisor.ts` 持有临时目录，总期限为5分钟，包含启动、执行、收尾及等待 Worker 退出；失败、取消或超时会终止 Worker。
只有确认 Worker 的 exit 事件后才删除整个临时根；终止失败或10秒内不能确认退出时明确报失败并保留目录，不能靠 Promise.race 后继续删库。
brain.stop 拒绝时不恢复 fetch、不关闭尚可能被使用的资源，留给监督器终止执行者。通过记录暂存，全部执行/收尾、Worker 正常退出和目录删除成功后才统一输出；中途失败不输出任何“脚本化通过”。
`nonFixtureNetworkAttempts=0` 指 fetch 守卫观察到的请求，不是独立网络抓包证明。

原 CLI 入口保持兼容：

```sh
PIBOT_TOOLS_DIR=/private/tmp/pibot-t9-fixture-logs pnpm fake-llm --scenario collaboration --port 8000
```

这里只启动假服务。负责人需另行使用独立测试数据目录和合成凭据操作窗口；本任务没有启动窗口。
CLI 日志只记请求结构（method/规范 path/字节数/认证是否存在/消息和工具数量/stream），不记请求正文。
CLI 请使用新建的临时日志目录，退出后由负责人清理；不要连接含真实聊天或凭据的资料目录。
服务重启重置序列，任何额外 probe/聊天都会消耗对应剧本，耗尽后只回复“场景执行完毕”。

## 身份和剧本约定

原 `replies` 是**全局顺序**，不识别 Bot UUID，不能自动适配任意 Bot。
可选 `routes` 按请求的**明确 model ID** 独立消费数组；未匹配则使用全局 `replies`。
`collaboration` / `mentions` / `paused` / `approval` 需如下配置：

| Bot 名称（群内唯一） | 自定义模型 ID | 上下文/最大输出 | 角色 |
|---|---|---|---|
| 统筹（脚本中主 Pi） | coordinator | 32768 / 2048 | 群统筹 |
| 研究员 | researcher | 32768 / 2048 | 研究任务与 ask_bot 答复 |
| 写手 | writer | 32768 / 2048 | 写作、ask_bot、显式 @ |

三个模型都用本项假服务 `/v1`、`openai-completions`、合成 Key、思考 off。
先在没有模型时建立两个 Bot，再显式设置名字/模型，避免人设请求消耗协作剧本。
脚本登记本库合成厂商后经 `settings.set.defaultModel` 设置 coordinator/off，再逐 Bot 配置；普通默认保存不改 Pi，也不使用欢迎双写标记。两库厂商 UUID 不同，团队导入的失效模型按第二库应用默认回退，不依赖 Pi 或随机模型。
这些名字和 ID 是验收固定夹具，不是按任意同名 Bot、系统 prompt 或 UUID 自动路由。
聊天 fixture 对全局回复和各 model route 应用 `tool-discovery.ts::withToolDiscovery`；例行任务演练在替换回复路由时复用同一 helper。调用方注入当前真实 `toolLoadGroup`，分组工具前插入经过正常权限闸门的 `tool_discover`，不改生产工具可见性或授权。纯回复变换不直接依赖 brain，保持工具入口的 `erasableSyntaxOnly` 编译边界。
`assign_task` / `ask_bot` 参数使用群内唯一名字，后端真实校验成员及执行者身份；线程 ID 来自真实任务记录。
回复的 model 回显合法请求 ID，让 SDK 能关联 usage；GET 模型目录仍仅列 `fake-model`，上述三个 ID 要明确配置。

| 剧本 | 进入路径 | 核对结果 | 局限 |
|---|---|---|---|
| persona | 已配置假模型→bots.create 描述→改名/模型→archive | JSON 人设解析、资料持久化、列表归档隐藏 | 不是 UI 自动生成/头像或运行中归档验收 |
| collaboration | 三成员群、上限10→chat.send | 统筹用户任务和两个派工任务 done，按 source 区分；写手 ask_bot、研究员答复、统筹 wake | 每 Bot 模型序列固定，不能任意插入聊天 |
| 同剧本上限2 | 新服务/新群，上限2→同一发送 | rounds=2/limited；只入队两次自动运行，第3次被阻止 | 不证明窗口提示/长期容量压力 |
| mentions | @写手 @研究员 @写手 | receipt 首出现顺序去重，统筹零请求 | 补全、IME/键盘仍手验 |
| paused | groups.update paused→@写手 | 显式答复；ask_bot 自动请求被阻止 | 暂停按钮/在途取消仍手验 |
| approval | 群命令 ask，研究员单聊覆盖 never→@两者 | 单聊 never 保留、群仍 ask；按 @ 顺序逐张核对两人审批的 Bot/run/message，拒绝后无 exec.started | 一律 deny，不执行命令、不验证隔离或危险审批 UI |
| memory | auto→memory_add→新话题→ask→拒绝→删除 | 分类 how_to；下一请求有记忆，ask 提案未直接保存，删除仓储条目 | 假回复不证明模型理解偏好；旧 JSONL 不清洗 |
| compaction | researcher 私聊，先两轮长合成文本，第三轮继续 | 当前模型摘要请求无工具；JSONL 一条 compaction，正常继续 | usage 为合成数值，不验证真实 tokenizer |
| compaction-failure | 同长历史；摘要 length | compaction_failed、零 compaction、无默认摘要/后续聊天请求 | 不穷举所有厂商错误 |
| compaction-cancel | 同长历史；摘要延迟时 chat.abort 真实 run | 状态携真实身份；run aborted，零 compaction | 不是系统窗口停止或网络失联 drain 验收 |
| compaction-overflow | 两轮低 usage 长历史→第三轮 HTTP 400 | context_length_exceeded→摘要→一次 SDK 重试→done | 合成 HTTP 错误，不是厂商容量测量 |
| 模板演练（mentions） | teams.export→第二临时库 pickFile/import→聊天 | 3 Bot/1群、预览消费、权限空覆盖/记忆空、导入后可用 | BrainHost.teams 是内存假文件端口，原生授权/覆盖竞态未验证 |

全局压缩顺序必须重启后从第一轮开始：第一轮发送 `"Synthetic evidence. "` 重复1200次，第二轮重复1600次，再按表继续。ASCII 让 SDK 的 chars/4 切点估算与应用估算一致；每次请求适配当前32K窗口，第二轮之后有完整的旧轮次可摘要，不能沿用会先撞请求上限的旧中文长输入。
threshold/失败/取消剧本第一回复合成 input usage=7400，第二回复=26000，触发当前窗口的整理；overflow 前两回复低 usage，第三回复 HTTP 400。摘要请求通过当前 `Create a concise work checkpoint` 指令识别，同时要求零工具、真实 compacting/JSONL 结果，不把模型普通文字当摘要证据。
摘要可能在第二轮收尾或第三轮预检发生，必须以真实 compacting/摘要请求判断，不能靠睡眠推断。
单轮即使 usage 高，也可能没有可摘要边界；不能把“没有摘要请求”当成压缩通过。
`promptTokens`、`finishReason=length` 和 `httpError=context_length_exceeded` 只控制 OpenAI 兼容响应；Ollama 保持旧格式，不声明同等压缩覆盖。

## 工程边界

`acceptance:chat` 不进入 Vitest。
`tests/e2e/chat/index.ts` 用已锁定 Vite 的 jiti 载入工作区实现（禁 fs cache）；没有直接引入 pi，仍由 `packages/agent` 唯一引入。
两份集成脚本有独立 tsconfig，允许所引用业务文件的 parameter properties；入口/监督器及其他 Node 工具保留 erasableSyntaxOnly，全部纳入根 typecheck。监督器借 protocol 现有 Zod 校验 Worker 结果，不引入新依赖；Worker 环境只注入同一白名单，禁继承 execArgv。
窗口相关项需要在真实应用里手动验收。
