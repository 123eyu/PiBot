import type { KernelHostParams, KernelHostResults } from "@pibot/protocol-base";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";

export interface AttachmentHost {
  image(
    params: KernelHostParams["host.attachments.image"],
    signal: AbortSignal,
  ): Promise<KernelHostResults["host.attachments.image"]>;
  pdf(
    params: KernelHostParams["host.attachments.pdf"],
    signal: AbortSignal,
  ): Promise<KernelHostResults["host.attachments.pdf"]>;
  /** Optional: hosts without an image toolkit (server brain) fall back to the original. */
  thumbnail?(
    params: KernelHostParams["host.attachments.thumbnail"],
    signal: AbortSignal,
  ): Promise<KernelHostResults["host.attachments.thumbnail"]>;
  /** Thumbnail of an operation step's screenshot; optional like `thumbnail`. */
  stepThumbnail?(
    params: KernelHostParams["host.attachments.stepThumbnail"],
    signal: AbortSignal,
  ): Promise<KernelHostResults["host.attachments.stepThumbnail"]>;
  /** Thumbnail of an image-diff side staged under bots/<id>/changes/previews. */
  changeThumbnail?(
    params: KernelHostParams["host.attachments.changeThumbnail"],
    signal: AbortSignal,
  ): Promise<KernelHostResults["host.attachments.changeThumbnail"]>;
  open(params: KernelHostParams["host.attachments.open"]): Promise<void>;
}
export function requireAttachmentHost(host?: AttachmentHost): AttachmentHost {
  if (!host) throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_host_unavailable");
  return host;
}
