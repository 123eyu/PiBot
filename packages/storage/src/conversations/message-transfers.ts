import type { DatabaseSync } from "node:sqlite";
import { type MessageTransferReceipt, MessageTransferReceiptSchema } from "@pibot/protocol-base";

/** Receipts contain IDs and state only; quoted text never becomes an operation log. */
export class MessageTransfersRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string) {
    const row = this.db
      .prepare("SELECT request_hash,receipt_json FROM message_transfers WHERE request_id=?")
      .get(id);
    return row
      ? {
          hash: String(row.request_hash),
          receipt: MessageTransferReceiptSchema.parse(JSON.parse(String(row.receipt_json))),
        }
      : undefined;
  }
  create(requestId: string, hash: string) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO message_transfers(request_id,request_hash,receipt_json,created_at,updated_at) VALUES (?,?,?,?,?)",
      )
      .run(requestId, hash, JSON.stringify({ requestId, state: "pending" }), now, now);
  }
  save(receipt: MessageTransferReceipt) {
    this.db
      .prepare("UPDATE message_transfers SET receipt_json=?,updated_at=? WHERE request_id=?")
      .run(
        JSON.stringify(MessageTransferReceiptSchema.parse(receipt)),
        new Date().toISOString(),
        receipt.requestId,
      );
  }
  recover() {
    this.db
      .prepare(
        "UPDATE message_transfers SET receipt_json=json_set(receipt_json,'$.state','uncertain'),updated_at=? WHERE json_extract(receipt_json,'$.state')='pending'",
      )
      .run(new Date().toISOString());
  }
}
