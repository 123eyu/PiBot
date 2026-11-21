# @pibot/secrets

纯 Node 密钥边界，目前不提供数据库存储或生产加密实现。

- `SecretCipher`：宿主注入 `isAvailable / encrypt / decrypt`，桌面端通过 host RPC 调用 main 的 safeStorage。不可用时调用方必须拒绝保存，不能回退到明文。
- `MasterPasswordCipher`：纯 Node 主密码加密文件方案的接口，增加 `unlock / lock`。目前只有接口及测试文件内的不可用桩，不创建加密文件、不选择密码算法。
- `assertSafeSecretValue`：直接复用 protocol 的 `SafeSecretSchema`，拒绝空串、首尾空白、CR/LF、以 `!` 开头的值。异常固定为 `Unsafe secret value`，不携带输入明文。
- `createRedactor`：用 `add` 登记安全明文，`redact` 将全部匹配替换为 `[REDACTED]`。登记值按字面匹配，不解释正则元字符；重叠匹配合并，防止部分替换留下密钥后缀。实例互相独立，同一实例可以在日志创建后继续登记。
- `keyHint`：校验后返回最后四个 UTF-16 代码单元；少于四位时返回完整短值，与 protocol 的长度规则一致。

未登记值的补充识别涵盖 `sk-`（含 `sk-proj-`、`sk-ant-`）、`xai-`、`AIza`、GitHub 的 `ghp_ / gho_ / ghu_ / ghs_ / ghr_ / github_pat_`、`gsk_`、`hf_`。规则要求 token 边界和最小负载长度（通常 20，`AIza` 后 35），保留短示例和普通文字。这是格式启发式，所有已保存明文仍必须登记，不能仅依赖格式识别。

`SecretCipher` 接受一般 `Uint8Array`；protocol 的 host 参数类型目前推导为 `Uint8Array<ArrayBuffer>`。传入 host RPC 前可用 `new Uint8Array(value)` 复制，以兼容可能来自 SharedArrayBuffer 的视图；测试桩展示了这个边界。

依赖仅为现有工作区 `@pibot/protocol`，精确指定 `workspace:0.0.0`。SecretStore 的 `set / get / has / remove / hint` 数据库实现不在本包。
