import { DurableObject } from "cloudflare:workers";
import type { RelayEnv } from "../worker/types.ts";

// Accepted relay connections are counted per day × role × room kind.
// No room ID, peer, IP or content; only these aggregate rows are stored, for 400 days.
const KEEP_DAYS = 400;
const ROLES = new Set(["desktop", "phone", "runner"]);
const KINDS = new Set(["phone", "runner"]);

export class Stats extends DurableObject<RelayEnv> {
  private readonly sql: SqlStorage;
  private pruned = "";
  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, role, kind))",
    );
  }
  add(day: string, role: string, kind: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !ROLES.has(role) || !KINDS.has(kind)) return;
    if (this.pruned !== day) {
      const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - KEEP_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      this.sql.exec("DELETE FROM counts WHERE day < ?", cutoff);
      this.pruned = day;
    }
    this.sql.exec(
      "INSERT INTO counts (day, role, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, role, kind) DO UPDATE SET n = n + 1",
      day,
      role,
      kind,
    );
  }
  read(from: string) {
    return this.sql
      .exec<{ day: string; role: string; kind: string; n: number }>(
        "SELECT day, role, kind, n FROM counts WHERE day >= ? ORDER BY day, role, kind",
        from,
      )
      .toArray()
      .map(({ day, role, kind, n }) => ({ day, role, kind, count: n }));
  }
}

function stats(namespace: DurableObjectNamespace) {
  const typed = namespace as DurableObjectNamespace<Stats>;
  return typed.get(typed.idFromName("relay"));
}

/** Counting never delays or fails the connection; without the binding nothing is counted. */
export function countConnection(
  env: RelayEnv,
  ctx: ExecutionContext | undefined,
  role: string,
  kind: string,
) {
  if (!env.STATS || !ctx) return;
  const day = new Date().toISOString().slice(0, 10);
  // A lost count only makes the daily total a little low; the connection is unaffected.
  ctx.waitUntil(
    stats(env.STATS)
      .add(day, role, kind)
      .catch(() => undefined),
  );
}

async function sameSecret(given: string, expected: string) {
  const encoder = new TextEncoder();
  const digest = (value: string) => crypto.subtle.digest("SHA-256", encoder.encode(value));
  return crypto.subtle.timingSafeEqual(await digest(given), await digest(expected));
}

/** Aggregates only, behind the STATS_TOKEN Worker secret; without it the endpoint does not exist. */
export async function readStats(request: Request, env: RelayEnv) {
  if (!env.STATS || !env.STATS_TOKEN || request.method !== "GET")
    return new Response(null, { status: 404 });
  const given = /^Bearer (.{16,200})$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!(await sameSecret(given, env.STATS_TOKEN))) return new Response(null, { status: 404 });
  const from = new URL(request.url).searchParams.get("from") ?? "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(from)
    ? from
    : new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  return Response.json(
    { kind: "relay", from: day, rows: await stats(env.STATS).read(day) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
