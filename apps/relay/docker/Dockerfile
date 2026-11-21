# syntax=docker/dockerfile:1.7
# Pi Bot relay + STUN for your own server. Build from the repository root:
#   docker build -f apps/relay/docker/Dockerfile -t pibot-relay .
FROM node:22-bookworm-slim AS relay-build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches patches
COPY apps/relay/package.json apps/relay/package.json
COPY packages/link/package.json packages/link/package.json
RUN pnpm install --frozen-lockfile --filter @pibot/relay...
COPY tsconfig.base.json tsconfig.json ./
COPY apps/relay apps/relay
COPY packages/link packages/link
# The same bundle wrangler deploys to Cloudflare (memory env: no Stats, in-memory rate limits).
RUN cd apps/relay && WRANGLER_SEND_METRICS=false node tools/wrangler.ts deploy --dry-run --outdir /out --env memory \
 && cp "$(readlink -f node_modules/workerd)/../workerd-linux-64/bin/workerd" /out/workerd 2>/dev/null \
 || cp /src/node_modules/.pnpm/@cloudflare+workerd-linux-64@*/node_modules/@cloudflare/workerd-linux-64/bin/workerd /out/workerd

FROM caddy:2.10.2 AS caddy-source

FROM debian:bookworm-slim
# coturn from Debian brings its own libraries; only its STUN part is started (see entrypoint).
RUN apt-get update \
 && apt-get install --no-install-recommends -y ca-certificates tini coturn \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin pibot
COPY --from=relay-build /out/workerd /usr/local/bin/workerd
COPY --from=caddy-source /usr/bin/caddy /usr/local/bin/caddy
COPY --from=relay-build /out/ /opt/pibot-relay/
COPY apps/relay/docker/workerd.capnp apps/relay/docker/Caddyfile /opt/pibot-relay/
COPY apps/relay/docker/entrypoint.sh /usr/local/bin/pibot-relay-entrypoint
RUN rm -f /opt/pibot-relay/workerd \
 && chmod 0555 /usr/local/bin/workerd /usr/local/bin/caddy /usr/local/bin/pibot-relay-entrypoint \
 && mkdir -p /data && chown pibot:pibot /data
ENV HOME=/nonexistent XDG_CONFIG_HOME=/data/caddy/config XDG_DATA_HOME=/data/caddy/data \
    RELAY_PORT=8787 HTTPS_PORT=443 STUN_PORT=3478 ENABLE_STUN=1 TLS_MODE=internal
USER pibot
EXPOSE 443/tcp 3478/udp
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pibot-relay-entrypoint"]
