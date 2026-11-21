# workerd runs the same relay bundle Cloudflare runs (wrangler's --env memory build).
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "relay", worker = .relay),
    # Rooms keep no messages; the store only backs the Durable Object runtime.
    (name = "room-storage", disk = (path = "/data/relay", writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:8787", http = (), service = "relay")],
);

const relay :Workerd.Worker = (
  compatibilityDate = "2026-10-19",
  modules = [(name = "index.js", esModule = embed "index.js")],
  durableObjectNamespaces = [(className = "Room", uniqueKey = "pibot-relay-room", enableSql = true)],
  durableObjectStorage = (localDisk = "room-storage"),
  bindings = [
    (name = "ROOMS", durableObjectNamespace = "Room"),
    (name = "EXPO_ACCESS_TOKEN", fromEnvironment = "EXPO_ACCESS_TOKEN"),
  ],
);
