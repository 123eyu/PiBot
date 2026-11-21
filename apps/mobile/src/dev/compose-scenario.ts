import {
  createPeer,
  Methods,
  PHONE_CALL_ID_PREFIX,
  type Port,
  RpcErrorCodes,
} from "@pibot/protocol";
import { MESSAGE_FILE_BYTES, SHARE_SLICE_BYTES } from "../features/share/upload.ts";
import { MobileRuntime } from "../runtime/runtime.ts";
import { toBase64 } from "../storage/base64.ts";
import type { ChatTarget, Computer, PendingFile } from "../transport/link-port.ts";
import {
  fakeJpeg,
  memoryShare,
  memoryStorage,
  outcome,
  sessionLink,
  waitFor,
} from "./phone-data-scenario.ts";

/** The same desktop harness as `--phone-data` (packages/remote/dev/phone-data-desktop.ts). */
export interface ComposeDesktop {
  botId: string;
  desktopId: string;
  phonePort: Port;
  desktop: {
    call(method: "chat.history", params: object): Promise<unknown[]>;
    call(method: "bots.create", params: object): Promise<{ id: string }>;
    call(method: "groups.create", params: object): Promise<{ id: string; conversationId: string }>;
  };
  settled(): Promise<void>;
}
/** Replies for the runs the phone's sends start (Bot turns are not what this probe checks). */
export const COMPOSE_SCRIPT = Array.from({ length: 12 }, (_, i) => ({
  text: `Got it (${i + 1}).`,
}));

/** One JSON-RPC frame straight onto the session, bypassing client-side schemas. */
function rawRequest(port: Port, method: string, params: unknown) {
  const id = `compose-${crypto.randomUUID()}`;
  return new Promise<string>((resolve) => {
    const stop = port.onMessage((raw) => {
      const reply = raw as { id?: unknown; error?: { code: number; message: string } };
      if (reply?.id !== id) return;
      stop?.();
      resolve(reply.error ? `${reply.error.code}:${reply.error.message}` : "accepted");
    });
    port.post({ jsonrpc: "2.0", id, method, params });
  });
}
const atobBytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/**
 * Composer attachments end to end through the desktop's real phone gateway and brain: the phone app's own
 * runtime sends composer attachments — text + image + file online (sliced upload, progress,
 * chat.send with attachmentIds), an attachment-only message, an offline send kept in the outbox
 * with its files until the link is back, a refused send that stays pending with retry / remove,
 * a group message — and the attachment restrictions at the gateway and in the outbox.
 */
export async function runComposeScenario(desktop: ComposeDesktop) {
  let checks = 0;
  const check = (value: unknown, label: string) => {
    if (!value) throw new Error(`compose_check_${label}`);
    checks++;
  };
  const computer: Computer = {
    id: desktop.desktopId,
    name: "Probe computer",
    relay: "wss://development.invalid",
    publicKey: "development-public-key",
    safetyCode: "123456",
  };
  const share = memoryShare();
  const storage = memoryStorage(share);
  const runtime = new MobileRuntime(storage, sessionLink(desktop, computer), 0, {
    platform: "android",
  });
  const progress: number[] = [];
  const off = runtime.subscribe(() => {
    for (const value of Object.values(runtime.getSnapshot().uploads)) progress.push(value);
  });
  await runtime.initialize();
  await runtime.preparePair("development-qr", "Probe phone");
  await runtime.savePair();
  const online = () => waitFor(() => runtime.getSnapshot().status === "online", "online");
  await online();
  // A Bot's first topic, created from the phone as the chat page does for a Bot without one.
  const topicId = (await runtime.call("topics.create", { botId: desktop.botId })).id;
  const dm: ChatTarget = { botId: desktop.botId, topicId };
  const image = (name: string): PendingFile => {
    const bytes = atobBytes(fakeJpeg(640, 480));
    return {
      kind: "image",
      name,
      mimeType: "image/jpeg",
      blob: share.add(bytes),
      bytes: bytes.length,
    };
  };
  const textFile = (name: string, kb: number): PendingFile => {
    const bytes = new TextEncoder().encode("composer notes line\n".repeat((kb * 1024) / 20));
    return {
      kind: "file",
      name,
      mimeType: "text/plain",
      blob: share.add(bytes),
      bytes: bytes.length,
    };
  };
  const drained = (label: string) =>
    waitFor(() => runtime.getSnapshot().pending === 0, label, 30_000).catch(async (error) => {
      const { pending, failed, status } = runtime.getSnapshot();
      const rows = (await storage.outbox(computer.id)).map((r) => r.text);
      throw new Error(`${String(error)} ${JSON.stringify({ pending, failed, status, rows })}`);
    });
  const history = async (target: object) =>
    JSON.stringify(await desktop.desktop.call("chat.history", { ...target, limit: 20 }));
  const report: Record<string, unknown> = {};

  // 1. Online: text + image + a file of three slices.
  const photo = image("IMG_0001.jpg");
  const notes = textFile("notes.txt", 1300);
  await runtime.send(dm, "Photo and notes from the composer", undefined, [photo, notes]);
  await drained("online_sent");
  let seen = await history({ botId: desktop.botId, topicId });
  check(seen.includes("Photo and notes from the composer"), "online_text");
  check(seen.includes("IMG_0001.jpg") && seen.includes("notes.txt"), "online_attachments");
  check(!share.blobs.has(photo.blob) && !share.blobs.has(notes.blob), "online_copies_removed");
  const partial = progress.filter((v) => v > 0 && v < 1);
  check(partial.length >= 2, "upload_progress");
  check(Object.keys(runtime.getSnapshot().uploads).length === 0, "progress_cleared");
  report.online = {
    slices: Math.ceil(notes.bytes / SHARE_SLICE_BYTES) + 1,
    progressSteps: partial.map((v) => Math.round(v * 100)),
    stored: ["IMG_0001.jpg", "notes.txt"],
  };
  await desktop.settled();

  // 2. Attachments only, no text.
  const only = image("only-image.jpg");
  await runtime.send(dm, "", undefined, [only]);
  await drained("image_only");
  seen = await history({ botId: desktop.botId, topicId });
  check(seen.includes("only-image.jpg"), "attachment_only");
  report.attachmentOnly = "stored without text";
  await desktop.settled();

  // 3. Offline: queued with its files kept, drained on reconnect.
  await runtime.setForeground(false);
  await waitFor(() => runtime.getSnapshot().status === "suspended", "offline");
  const queuedFile = textFile("offline.txt", 4);
  const queuedPhoto = image("offline.jpg");
  await runtime.send(dm, "Written while offline", undefined, [queuedFile, queuedPhoto]);
  const waiting = await storage.outbox(computer.id);
  check(
    runtime.getSnapshot().pending === 1 &&
      waiting[0]?.files?.length === 2 &&
      share.blobs.has(queuedFile.blob) &&
      share.blobs.has(queuedPhoto.blob),
    "offline_queued",
  );
  // Outbox bounds: at most 32 MB per message and 100 MB of files waiting in all.
  const fake = (bytes: number): PendingFile => ({
    kind: "file",
    name: "big.pdf",
    mimeType: "application/pdf",
    blob: crypto.randomUUID(),
    bytes,
  });
  const tooLarge = await outcome(() =>
    runtime.send(dm, "", undefined, [fake(20_000_000), fake(15_000_000)]),
  );
  const fill = [];
  for (let i = 0; i < 4; i++)
    fill.push(await outcome(() => runtime.send(dm, `fill ${i}`, undefined, [fake(30_000_000)])));
  const sixFiles = await outcome(() =>
    runtime.send(
      dm,
      "six",
      undefined,
      Array.from({ length: 6 }, () => fake(10)),
    ),
  );
  check(tooLarge === "Error: attachments_too_large", "message_budget");
  check(
    fill.slice(0, 3).every((v) => v === "accepted") && fill[3] === "Error: outbox_files_full",
    "outbox_budget",
  );
  check(sixFiles !== "accepted", "max_five_files");
  // The two fillers have no bytes behind them; take them out before going online.
  for (const row of (await storage.outbox(computer.id)).filter((r) => r.text.startsWith("fill")))
    await storage.acknowledge(computer.id, row.clientId);
  report.outboxBounds = {
    perMessage: tooLarge,
    pendingTotal: fill[3],
    sixFiles: sixFiles.includes("too_big") ? "refused (at most 5)" : sixFiles,
  };
  await runtime.setForeground(true);
  await online();
  await drained("offline_drained");
  seen = await history({ botId: desktop.botId, topicId });
  check(
    seen.includes("Written while offline") &&
      seen.includes("offline.txt") &&
      seen.includes("offline.jpg"),
    "offline_delivered",
  );
  check(!share.blobs.has(queuedFile.blob) && !share.blobs.has(queuedPhoto.blob), "offline_cleaned");
  report.offline = "queued with 2 files, sent on reconnect, copies removed";
  await desktop.settled();

  // 4. A send the computer refuses (a topic it does not have): stays pending, retry, remove.
  const stray = image("stray.jpg");
  await runtime.send({ botId: desktop.botId, topicId: crypto.randomUUID() }, "Lost", undefined, [
    stray,
  ]);
  await waitFor(() => !!runtime.getSnapshot().failed, "failed");
  const failedId = runtime.getSnapshot().failed as string;
  check(runtime.getSnapshot().pending === 1 && share.blobs.has(stray.blob), "failed_kept");
  await runtime.retry();
  await waitFor(() => runtime.getSnapshot().failed === failedId, "failed_again");
  await runtime.discard(failedId);
  check(
    runtime.getSnapshot().pending === 0 &&
      !share.blobs.has(stray.blob) &&
      !runtime.getSnapshot().failed,
    "discarded",
  );
  report.refused = "kept pending, retried, removed with its copy";

  // 5. A group: text + file with the same path.
  const second = await desktop.desktop.call("bots.create", {
    name: "Probe helper",
    description: "A second Bot for the group probe",
  });
  const group = await desktop.desktop.call("groups.create", {
    name: "Probe group",
    botIds: [desktop.botId, second.id],
  });
  const groupFile = textFile("group-plan.txt", 2);
  await runtime.send(
    { groupId: group.id, topicId: group.conversationId },
    "For the group",
    undefined,
    [groupFile],
  );
  await drained("group_sent");
  seen = await history({ groupId: group.id, topicId: group.conversationId });
  check(seen.includes("For the group") && seen.includes("group-plan.txt"), "group_attachment");
  report.group = "text + file stored in the group topic";

  // 6. Gateway restrictions, from a raw client on the same session.
  const raw = createPeer(
    {
      post: (m) => desktop.phonePort.post(m),
      onMessage: (fn) =>
        desktop.phonePort.onMessage((m) => {
          const id = (m as { id?: unknown } | null)?.id;
          if (!(typeof id === "string" && id.startsWith(PHONE_CALL_ID_PREFIX))) fn(m);
        }),
    },
    { methods: Methods, events: {} },
  );
  const upload = async (name: string) => {
    const data = toBase64(new TextEncoder().encode("probe"));
    const receipt = await raw.call("remote.share.upload", {
      kind: "file",
      name,
      mimeType: "text/plain",
      total: data.length,
      offset: 0,
      chunk: data,
    });
    return receipt.attachmentId as string;
  };
  const refusedId = await upload("refused.txt");
  const sendWith = (id: string, target: object) =>
    outcome(() =>
      raw.call("chat.send", {
        ...target,
        text: "x",
        attachmentIds: [id],
        clientMessageId: crypto.randomUUID(),
      } as never),
    );
  const appendId = await upload("steer.txt");
  report.restrictions = {
    foreignAttachmentId: await sendWith(crypto.randomUUID(), dm),
    // The kernel refuses this send; its upload is released, not held for 10 minutes.
    refusedSend: await sendWith(refusedId, { botId: desktop.botId, topicId: crypto.randomUUID() }),
    refusedUploadReused: await sendWith(refusedId, dm),
    // chat.append's own schema has no attachments, so a peer would refuse it before sending; the
    // gateway must refuse a hand-made frame too (steering stays text only, as the composer shows).
    steerWithAttachment: await rawRequest(desktop.phonePort, "chat.append", {
      botId: desktop.botId,
      topicId,
      runId: crypto.randomUUID(),
      mode: "steer",
      text: "x",
      attachmentIds: [appendId],
    }),
    oversizedMessage: `phone keeps a message within ${MESSAGE_FILE_BYTES} bytes`,
  };
  raw.dispose();
  const r = report.restrictions as Record<string, string>;
  const unavailable = `${RpcErrorCodes.invalidParams}:remote_attachment_unavailable`;
  check(r.foreignAttachmentId === unavailable, "foreign_id_refused");
  check(r.refusedSend !== "accepted", "refused_send");
  check(r.refusedUploadReused === unavailable, "refused_upload_released");
  check(
    r.steerWithAttachment === `${RpcErrorCodes.invalidParams}:remote_parameter_unavailable`,
    "steer_text_only",
  );
  off();
  await desktop.settled().catch(() => undefined);
  await runtime.dispose();
  return { checks, ...report };
}
