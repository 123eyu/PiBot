import { RpcError, RpcErrorCodes } from "@pibot/protocol";

/** Never display a raw server error: only known refusal categories are user-facing. */
export function userQuestionError(error: unknown) {
  if (!(error instanceof RpcError)) return "execution.questionError";
  if (error.message === "question_changed") return "execution.questionChanged";
  if (error.message === "question_already_answered") return "execution.questionAlreadyAnswered";
  if (error.message === "question_unavailable") return "execution.questionUnavailable";
  if (error.code === RpcErrorCodes.busy) return "execution.questionBusy";
  if (error.code === RpcErrorCodes.timeout) return "execution.questionTimeout";
  if (error.code === RpcErrorCodes.closed) return "execution.questionDisconnected";
  if (error.code === RpcErrorCodes.noModel) return "execution.questionNoModel";
  if (error.code === RpcErrorCodes.secretsUnavailable) return "execution.questionSecrets";
  return "execution.questionError";
}
