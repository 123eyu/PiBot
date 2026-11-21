import type { ImageDelivery } from "@pibot/images-contract/full";

export function imageDeliveryText(language: "zh" | "en", delivery?: ImageDelivery) {
  const zh = language === "zh";
  if (!delivery)
    return zh
      ? "图片已交付为附件；工作目录保存状态尚未确认。"
      : "Image delivered as an attachment; workspace save is unconfirmed.";
  return delivery.workspace
    .filter((item) => item.status !== "saved")
    .map((item) =>
      zh
        ? `附件已保留；目录保存${item.status === "denied" ? "被拒绝" : item.status === "cancelled" ? "已取消" : item.status === "needs_verification" ? "需核实" : "失败"}（${item.fileName}，${item.errorCode ?? "internal"}）。仅保存重试不会重新生成图片。`
        : `Attachment retained; workspace save ${item.status} (${item.fileName}, ${item.errorCode ?? "internal"}). Save-only retry never regenerates the image.`,
    )
    .join("\n");
}
