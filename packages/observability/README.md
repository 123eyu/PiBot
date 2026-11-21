# @pibot/observability

`createLogger({ dir, redactor, dev? })` 返回 `info / warn / error`，每个方法接受字符串并同步追加一行 JSON；字段为 `timestamp`、`level`、`message`。成功返回表示追加已完成，无需 close 或 flush；不承诺 fsync。文件和时间戳均使用 UTC，文件名为 `YYYY-MM-DD.log`。

消息在 JSON 编码前调用 `redactor.redact`，保证包含引号、反斜杠、制表符的登记明文也能被替换；换行编码为转义字符，避免伪造额外日志行。文件和开发控制台使用同一份脱敏后的记录。脱敏或文件操作失败会抛错，调用方应处理异常。

创建 logger 和日期改变后的第一次写入会清理旧文件，保留当天及前 13 个 UTC 日期。只删除名称符合格式、日期有效的普通日志文件，不处理其他文件、目录、符号链接或未来日期文件。目录默认以 `0700` 创建，新日志文件默认 `0600`（由平台和 umask 决定，已有路径权限不修改）。

`dev` 默认读取 `NODE_ENV === "development"`，宿主可显式传入开发标记。开发模式分别镜像到 `console.info / warn / error`，生产模式只写文件。不依赖 Electron，不访问用户数据目录以外的隐式路径，不发送网络请求。

依赖仅为现有工作区 `@pibot/secrets`，精确指定 `workspace:0.0.0`，仅导入 Redactor 类型。
