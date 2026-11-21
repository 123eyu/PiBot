import type { DatabaseSync } from "node:sqlite";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
/** Pending after a crash is uncertain, never permission to replay a side effect. */
export class RemoteReceiptsRepo {
  constructor(private readonly db: DatabaseSync) {}
  begin(
    deviceId: string,
    clientId: string,
    fingerprint: string,
  ): { fresh: boolean; result?: unknown } {
    const row = this.db
      .prepare(
        "SELECT fingerprint,result FROM remote_send_receipts WHERE device_id = ? AND client_id = ?",
      )
      .get(deviceId, clientId);
    if (row) {
      if (row.fingerprint !== fingerprint)
        throw new RpcError(RpcErrorCodes.invalidParams, "remote_message_id_conflict");
      if (row.result === null) throw new RpcError(RpcErrorCodes.busy, "remote_message_uncertain");
      return { fresh: false, result: JSON.parse(String(row.result)) };
    }
    const n = Number(
      this.db
        .prepare("SELECT count(*) AS n FROM remote_send_receipts WHERE device_id = ?")
        .get(deviceId)?.n,
    );
    // Silently evicting receipts would let an old offline client replay accepted messages.
    if (n >= 100_000) throw new RpcError(RpcErrorCodes.busy, "remote_receipt_capacity");
    this.db
      .prepare(
        "INSERT INTO remote_send_receipts(device_id,client_id,fingerprint,created_at) VALUES(?,?,?,?)",
      )
      .run(deviceId, clientId, fingerprint, new Date().toISOString());
    return { fresh: true };
  }
  /** A send the kernel refused stored nothing; its ID may be sent again (proposal 5). */
  release(deviceId: string, clientId: string) {
    this.db
      .prepare(
        "DELETE FROM remote_send_receipts WHERE device_id = ? AND client_id = ? AND result IS NULL",
      )
      .run(deviceId, clientId);
  }
  complete(deviceId: string, clientId: string, result: unknown) {
    this.db
      .prepare(
        "UPDATE remote_send_receipts SET result = ? WHERE device_id = ? AND client_id = ? AND result IS NULL",
      )
      .run(JSON.stringify(result), deviceId, clientId);
  }
}
