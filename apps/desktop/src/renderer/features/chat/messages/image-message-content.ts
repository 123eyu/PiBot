import { ImageDeliverySchema, type Message } from "@pibot/protocol";

/** Old replies included the same saved paths as the delivery card; preserve all other text. */
export function imageMessageContent(message: Message) {
  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage) || usage.imageGeneration !== true)
    return message.content;
  const delivery = ImageDeliverySchema.safeParse(usage.imageDelivery);
  if (!delivery.success || !delivery.data.workspace.every((item) => item.status === "saved"))
    return message.content;
  for (const label of ["已保存：", "Saved: "]) {
    const suffix = delivery.data.workspace.map((item) => `${label}${item.savedPath}`).join("\n");
    if (message.content.endsWith(`\n\n${suffix}`))
      return message.content.slice(0, -suffix.length).trimEnd();
  }
  return message.content;
}
