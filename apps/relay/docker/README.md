# Pi Bot 自建中继 Docker 镜像

此镜像把同一份 `apps/relay` Worker、Cloudflare `workerd`、Caddy TLS 入口和可选 coturn STUN 放在一个非 root 容器里。容器内中继只监听 `127.0.0.1`；外部只暴露 Caddy 的 HTTPS 和 STUN UDP 端口。任一进程退出，tini/入口脚本都会结束容器。

## 构建与启动

```sh
pnpm --filter @pibot/relay image
cp apps/relay/docker/docker-compose.yml relay-compose.yml
# 公网：TLS_MODE=public、DOMAIN=relay.example.com，并把 80/443 转给 HTTPS_PORT
# 内网：TLS_MODE=internal，改 DOMAIN 和 HTTPS_PORT（例如 8443）
docker compose -f relay-compose.yml up -d
```

客户端填写 `wss://DOMAIN:HTTPS_PORT` 和 `stun:DOMAIN:STUN_PORT`。公网模式需要域名解析到服务器，并让 Caddy 能接收 80/443 的 ACME 流量；自定义证书使用 `TLS_MODE=certificate`、`TLS_CERT`、`TLS_KEY`（路径必须挂载进容器）。内网模式的根证书会持久化在 `/data/caddy`，入口日志打印路径和 SHA-256 指纹；把该根证书安装到电脑和执行端的信任库后再连接。手机端暂不支持用户安装内网自签根证书，因此不能使用这种模式。

`EXPO_ACCESS_TOKEN` 可选，仅用于推送；不设置仍可连接。`ENABLE_STUN=0` 可关闭 coturn。镜像不写访问日志，Caddy admin、自动遥测和更新检查均关闭。

## 许可

中继运行时 `workerd` 使用 Apache-2.0；Caddy 使用 Apache-2.0；coturn 使用 BSD 许可。镜像构建不把构建工具链带入最终层；第三方完整许可文本随各发行包提供。

Docker 构建、内网配对和 STUN 响应不能在 Codex 沙箱执行。Claude 应在沙箱外构建镜像，传到 `10.1.0.58`，使用 HTTPS `8443` 与 UDP `3478`，验证电脑测试实例和执行端经自建中继配对、局域网直连，以及 STUN 有回应。
