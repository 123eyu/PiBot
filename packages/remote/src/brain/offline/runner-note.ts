import { runnerDeviceId, unbase64 } from "@pibot/link";
import type { RemoteDevicesRepo } from "../../store/index.ts";

/** What a phone's offline run can do with runners, told to its model in one line. */
export type RunnerNote =
  | { kind: "ready"; name: string; folder: string }
  | { kind: "unreachable"; name: string; folder: string }
  | { kind: "none" };

/**
 * v0.0.2 phone test: asked to run a command on a runner, the offline Bot said "the computer
 * cannot be reached", while the real reasons were that its topic's runner was offline when the
 * phone synced, and that the runner asked for was not its topic's. This line names the runner it
 * may use, or why there is none, so the answer is the true one. It comes after the fixed phone
 * rule, so the cacheable prefix is unchanged.
 */
export function runnerNoteText(language: "zh" | "en", note: RunnerNote) {
  if (language === "zh") {
    if (note.kind === "ready")
      return `本话题的执行端：${note.name} · ${note.folder}。执行端工具只在这里工作；用户要用别的执行端时，说明要等电脑连上后，把话题移到那台执行端上的文件夹。`;
    if (note.kind === "unreachable")
      return `本话题的文件夹在执行端 ${note.name} 上（${note.folder}），但手机上次和电脑同步时电脑连不上这台执行端，所以这次没有执行端工具。说明要在电脑和这台执行端都在线时同步一次，之后手机才能直接指挥它。`;
    return "本话题的文件夹不在执行端上，所以这次没有执行端工具。用户要在某台执行端上运行命令时，说明要等电脑连上后，把话题移到那台执行端上的文件夹；之后电脑离线时手机也能直接指挥它。";
  }
  if (note.kind === "ready")
    return `This topic's runner: ${note.name} · ${note.folder}. Runner tools work only there; for another runner, explain that the topic has to be moved to a folder on that runner once the computer is reachable.`;
  if (note.kind === "unreachable")
    return `This topic's folder is on the runner ${note.name} (${note.folder}), but the computer could not reach that runner when the phone last synced, so no runner tools are offered now. Explain that the computer and this runner have to be online together for one sync before the phone can control it directly.`;
  return "This topic's folder is not on a runner, so no runner tools are offered now. When the user wants a command run on a runner, explain that the topic has to be moved to a folder on that runner once the computer is reachable; after that the phone can control it while the computer is offline.";
}

function findRunner(devices: RemoteDevicesRepo, match: (target: string) => boolean) {
  let after: string | undefined;
  // Paired devices are few; the cap only bounds a damaged table.
  for (let pages = 0; pages < 10; pages++) {
    const page = devices.page({ after, limit: 100 });
    for (const device of page.items)
      if (
        device.kind === "runner" &&
        device.publicKey &&
        match(`runner:${runnerDeviceId(unbase64(device.publicKey, 32))}`)
      )
        return device;
    if (!page.nextAfter) return undefined;
    after = page.nextAfter;
  }
  return undefined;
}
/** The paired runner's name for a `runner:<id>` location, also while it is offline. */
export function runnerName(devices: RemoteDevicesRepo, target: string) {
  return findRunner(devices, (id) => id === target)?.name;
}
export function hasRunners(devices: RemoteDevicesRepo) {
  return !!findRunner(devices, () => true);
}
