import { RpcError } from "@pibot/protocol-base";

/** Only deliberately authored collaboration guidance may reach the model. */
export class GroupToolError extends RpcError {
  constructor(message: string) {
    super(-32602, message);
  }
}
