import type { ConnectorStream } from "@pibot/plugins-contract/full";
import type { SecretStore } from "@pibot/storage";
import { z } from "zod";

const requestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(128), z.number().safe()]),
  method: z.literal("pibot/secrets"),
  params: z.strictObject({
    method: z.enum(["get", "set", "delete"]),
    name: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    value: z.string().min(1).max(8192).optional(),
  }),
});
const valuesSchema = z.record(z.string(), z.string().max(8192));

/** One owner per service serializes all connections sharing an installation. */
export function createPluginSecrets(store: SecretStore, registerSecret?: (value: string) => void) {
  const queues = new Map<string, Promise<unknown>>();
  return (installationId: string, verify: () => void) => async (input: unknown) => {
    const request = requestSchema.parse(input);
    // Register before any asynchronous vault read so a plugin cannot race a set with stderr.
    if (request.params.method === "set") registerSecret?.(request.params.value ?? "");
    const work = (queues.get(installationId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        verify();
        const scope = `plugin-runtime:${installationId}`;
        const saved = await store.get(scope, "values");
        const values = valuesSchema.parse(saved ? JSON.parse(saved) : {});
        const { method, name, value } = request.params;
        if (method === "get") {
          const result = values[name];
          if (result !== undefined) registerSecret?.(result);
          return result === undefined ? {} : { value: result };
        }
        if (method === "set") {
          if (!value || Buffer.byteLength(value) > 8192) throw new Error("plugin_secret_limit");
          values[name] = value;
        } else delete values[name];
        if (Object.keys(values).length > 32 || Buffer.byteLength(JSON.stringify(values)) > 32768)
          throw new Error("plugin_secret_limit");
        const commit = await store.prepareSet(scope, "values", JSON.stringify(values));
        verify();
        commit();
        return {};
      });
    queues.set(installationId, work);
    void work
      .finally(() => {
        if (queues.get(installationId) === work) queues.delete(installationId);
      })
      .catch(() => {});
    return work;
  };
}

/** Consume only the private request method; secret responses never enter MCP tool results. */
export function pluginSecretStream(
  stream: ConnectorStream,
  handle: (input: unknown) => Promise<unknown>,
  signal: AbortSignal,
): ConnectorStream {
  return {
    ...stream,
    write: stream.write.bind(stream),
    close: stream.close.bind(stream),
    onClose: stream.onClose.bind(stream),
    onMessage(listener) {
      return stream.onMessage((message) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(message);
        } catch {
          listener(message);
          return;
        }
        if (
          ![
            "pibot/secrets",
            "pibot/oauth-loopback",
            "pibot/enabled-tools",
            "pibot/open-external",
          ].includes(String(parsed?.method))
        ) {
          listener(message);
          return;
        }
        const id = parsed.id;
        if (typeof id !== "string" && typeof id !== "number") return;
        void handle(parsed)
          .then(
            (result) => stream.write(JSON.stringify({ jsonrpc: "2.0", id, result }), signal),
            () =>
              stream.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32000, message: "plugin_secrets_unavailable" },
                }),
                signal,
              ),
          )
          .catch(() => {
            /* Closing the connection cancels private replies. */
          });
      });
    },
  };
}
