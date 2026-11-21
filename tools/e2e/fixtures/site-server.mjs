import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

// Receipts stay in this process; the runner's random token is never served to the page.
export async function startSite(kind, port = 0, token = "") {
  const receipts = [];
  const login = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>E2E 登录</title>
<form method="post" action="/login"><label>用户名<input name="username" autocomplete="username"></label>
<label>密码<input name="password" type="password" autocomplete="current-password"></label><button>登录</button></form></html>`;
  const teach = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>E2E 示教</title>
<button id="first">第一步</button><button id="second">第二步</button>
<label>备注<input id="note" name="note"></label><label>密码<input id="secret" type="password" name="password"></label>
<output id="result"></output><script>for(const b of document.querySelectorAll('button'))b.onclick=()=>{document.querySelector('output').textContent+=b.textContent+' ';};</script></html>`;
  // The page fetches a session token the model must never see; /api/echo records what a
  // Bot request sent. The token exists only here and in the receipt (runner-authenticated).
  const accessToken = `e2e-secret-${randomBytes(12).toString("hex")}`;
  const secretPage = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>E2E 秘密</title>
<p id="state">loading</p><script>fetch('/api/session').then(r=>r.json()).then(j=>{document.getElementById('state').textContent='ready:'+j.user;});</script></html>`;
  const htmlEscape = (v) =>
    v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const server = createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.url === "/__receipt") {
      if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(403).end();
      return res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(kind === "secret" ? { accessToken, receipts } : receipts));
    }
    if (kind === "secret" && req.method === "GET" && req.url === "/")
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(secretPage);
    if (kind === "secret" && req.url === "/api/session")
      return res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ user: "e2e-user", accessToken }));
    if (kind === "secret" && req.url === "/api/echo") {
      if (receipts.length < 20) receipts.push({ authorization: req.headers.authorization ?? null });
      return res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: req.headers.authorization === `Bearer ${accessToken}` }));
    }
    if (req.method === "GET" && req.url === "/")
      return res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(kind === "login" ? login : teach);
    if (kind !== "login" || req.method !== "POST" || req.url !== "/login")
      return res.writeHead(404).end();
    try {
      let size = 0;
      const parts = [];
      for await (const part of req) {
        size += part.length;
        if (size > 4096) throw new Error("form_limit");
        parts.push(part);
      }
      const fields = new URLSearchParams(Buffer.concat(parts).toString());
      if (receipts.length >= 20) throw new Error("receipt_limit");
      receipts.push({
        username: fields.get("username"),
        password: fields.get("password"),
      });
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(
          `<!doctype html><html lang="zh"><meta charset="utf-8"><p>已登录：${htmlEscape(fields.get("username") ?? "")}</p></html>`,
        );
    } catch {
      res.writeHead(400).end("form_rejected");
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    receipts,
    async stop() {
      const closed = new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}
