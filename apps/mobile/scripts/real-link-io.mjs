import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** RN still handles framing/events; only Android's native network bridge is replaced. */
export function configurePhoneSockets(phone, Socket) {
  const sockets = new Map();
  phone.configureNative({
    connect(url, _protocols, _options, id) {
      const socket = new Socket(url);
      sockets.set(id, socket);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () =>
        phone.emitNative("websocketOpen", { id, protocol: "" }),
      );
      socket.addEventListener("message", ({ data }) =>
        phone.emitNative("websocketMessage", {
          id,
          type: typeof data === "string" ? "text" : "binary",
          data: typeof data === "string" ? data : Buffer.from(data).toString("base64"),
        }),
      );
      socket.addEventListener("close", () => {
        phone.emitNative("websocketClosed", { id, code: 1000, reason: "closed" });
        sockets.delete(id);
      });
      socket.addEventListener("error", () =>
        phone.emitNative("websocketFailed", { id, message: "native_failed" }),
      );
    },
    send: (value, id) => sockets.get(id).send(value),
    sendBinary: (value, id) => sockets.get(id).send(Buffer.from(value, "base64")),
    close: (code, reason, id) => sockets.get(id)?.close(code, reason),
  });
}

/** Real SQLite and file-backed synthetic SecureStore values survive separate JS module owners. */
export function persistedPhoneStorage(root) {
  const securePath = join(root, "secure-store.json");
  const databases = new Set();
  const read = async () => {
    try {
      return JSON.parse(await readFile(securePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
  };
  return {
    async getItemAsync(key) {
      return (await read())[key] ?? null;
    },
    async setItemAsync(key, value) {
      await writeFile(securePath, JSON.stringify({ ...(await read()), [key]: value }), {
        mode: 0o600,
      });
    },
    async deleteItemAsync(key) {
      const rows = await read();
      delete rows[key];
      await writeFile(securePath, JSON.stringify(rows), { mode: 0o600 });
    },
    async openDatabaseAsync(name) {
      const db = new DatabaseSync(join(root, name));
      databases.add(db);
      return {
        async execAsync(sql) {
          db.exec(sql);
        },
        async getFirstAsync(sql, ...params) {
          return db.prepare(sql).get(...params);
        },
        async runAsync(sql, ...params) {
          return db.prepare(sql).run(...params);
        },
        async closeAsync() {
          db.close();
          databases.delete(db);
        },
      };
    },
    async raw() {
      const db = new DatabaseSync(join(root, "mobile-cache.db"));
      try {
        return {
          secure: await read(),
          registry: db.prepare("SELECT value FROM mobile_cache WHERE key = ?").get("registry")
            ?.value,
        };
      } finally {
        db.close();
      }
    },
    close() {
      for (const db of databases) db.close();
      databases.clear();
    },
  };
}
