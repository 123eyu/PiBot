// Actual startBackgroundOwner + startBrainHost + authenticated socket/control chain.
// Only native Electron surfaces and one explicit post-spawn fault are synthetic.
import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectBackground } from "../../src/main/background/background-connection.ts";
import { readDescriptor } from "../../src/main/background/background-directory.ts";
import { createBackgroundOwnerLifecycle } from "../../src/main/background/background-owner-lifecycle.ts";

const root = await mkdtemp("/private/tmp/pibot-bg-owner-");
const children: ChildProcess[] = [];
const passed: string[] = [];
const wait = async (predicate: () => boolean, limit = 5000) => {
  const until = Date.now() + limit;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error("private_owner_probe_deadline");
    await delay(5);
  }
};
try {
  const entry = resolve(process.argv[2] ?? ".cache/m3-bg/probe-background-owner-child.mjs");
  for (const scenario of [
    "socket-stop",
    "socket-fail",
    "socket-release-fail",
    "reserve-os-quit",
    "spawn-stop",
    "before-ready",
    "init-fail-child",
    "spawn-os-quit",
  ]) {
    const directory = join(root, scenario);
    await mkdir(directory, { mode: 0o700 });
    if (scenario === "init-fail-child")
      await writeFile(join(directory, ".pibot-routine-test"), "PIBOT_ROUTINE_TEST_ONLY", {
        mode: 0o600,
      });
    const child = fork(entry, [directory, scenario], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, HOME: directory },
    });
    children.push(child);
    const messages: Record<string, unknown>[] = [];
    let stderr = "";
    child.stderr?.on("data", (value) => {
      stderr += String(value);
    });
    child.on("message", (value) => messages.push(value as Record<string, unknown>));
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    const paused = (name: string) => messages.some((value) => value.paused === name);
    const alive = () => {
      assert.equal(child.exitCode, null, stderr);
      assert.equal(child.signalCode, null, stderr);
    };
    let connection: Awaited<ReturnType<typeof connectBackground>> | undefined;
    if (scenario.startsWith("socket")) {
      await wait(() => paused("socketPrivate") || child.exitCode !== null);
      alive();
      connection = await connectBackground(
        directory,
        "synthetic-v1",
        () => {},
        () => {},
      );
      const state = (await connection.control({ type: "state" })) as { lifecycle: string };
      assert.equal(state.lifecycle, "starting");
      assert.deepEqual(await connection.control({ type: "stop-service" }), { status: "requested" });
      await delay(40); // Keep the actual socketPrivate call in flight past the old 25ms timer.
      alive();
      assert.ok(await readDescriptor(directory));
      assert.equal(
        messages.some((value) => value.spawn),
        false,
      );
      assert.equal(
        messages.some((value) => String(value.error).includes("shutdown failed")),
        false,
      );
      child.send({ command: "release" });
    } else if (scenario === "reserve-os-quit") {
      await wait(() => paused("reserve-published") || child.exitCode !== null);
      alive();
      child.send({ command: "quit" });
      await delay(40);
      alive();
      assert.ok(await readDescriptor(directory));
      assert.equal(
        messages.some((value) => value.spawn),
        false,
      );
      child.send({ command: "release" });
    } else if (scenario === "spawn-stop") {
      await wait(() => paused("utility-publication") || child.exitCode !== null);
      alive();
      connection = await connectBackground(
        directory,
        "synthetic-v1",
        () => {},
        () => {},
      );
      assert.deepEqual(await connection.control({ type: "stop-service" }), { status: "requested" });
      await wait(() => messages.some((value) => value.utilityExit));
      alive();
      // Actual utility exit alone is insufficient while its publication is still in flight.
      assert.ok(await readDescriptor(directory));
      assert.equal(
        messages.some((value) => value.bootstrap),
        false,
      );
      child.send({ command: "release" });
    } else if (scenario === "before-ready") {
      await wait(() => messages.some((value) => value.bootstrap) || child.exitCode !== null);
      alive();
      connection = await connectBackground(
        directory,
        "synthetic-v1",
        () => {},
        () => {},
      );
      assert.equal(
        ((await connection.control({ type: "state" })) as { lifecycle: string }).lifecycle,
        "starting",
      );
      const descriptor = await readDescriptor(directory);
      assert.ok(descriptor.utilityPid);
      process.kill(descriptor.utilityPid, 0);
      assert.deepEqual(await connection.control({ type: "stop-service" }), { status: "requested" });
      assert.ok(await readDescriptor(directory));
    }
    if (scenario === "socket-release-fail") {
      await wait(() => messages.some((value) => String(value.error).includes("shutdown failed")));
      alive();
      assert.ok(await lstat(join(directory, "background-runtime", "owner.lock")));
      await assert.rejects(lstat(join(directory, "background-runtime", "owner.json")), {
        code: "ENOENT",
      });
      child.send({ command: "quit" });
    }
    await wait(() => child.exitCode !== null || child.signalCode !== null);
    await exited;
    connection?.close();
    assert.equal(child.exitCode, 0, `${scenario}: ${stderr}`);
    const result = messages.find((value) => value.quit)?.quit as {
      spawn: number;
      bootstrap: number;
      utilityExit: number;
      trayDestroy: number;
      quit: number;
    };
    assert.ok(result, JSON.stringify(messages));
    assert.equal(result.quit, 1);
    assert.equal(
      result.spawn,
      scenario.startsWith("socket") || scenario === "reserve-os-quit" ? 0 : 1,
    );
    assert.equal(result.bootstrap, scenario === "before-ready" ? 1 : 0);
    assert.equal(result.utilityExit, result.spawn);
    assert.equal(result.trayDestroy, result.spawn);
    assert.equal(
      messages.filter((value) => String(value.error).includes("shutdown failed")).length,
      scenario === "socket-release-fail" ? 1 : 0,
    );
    for (const pid of messages.filter((value) => value.spawn).map((value) => value.spawn as number))
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    for (const name of ["owner.lock", "owner.json"])
      await assert.rejects(lstat(join(directory, "background-runtime", name)), { code: "ENOENT" });
    passed.push(
      `${scenario}: actual owner/control; safe claim release, no extra bootstrap, real utility/owner exit, one cleanup`,
    );
  }
  // One cleanup attempt may fail without permanently poisoning stop or re-disposing
  // successfully released resources. This same coordinator is used by the actual owner.
  let init: () => void = () => {};
  const acquisition = new Promise<void>((resolve) => {
    init = resolve;
  });
  let releases = 0,
    disposals = 0,
    stops = 0,
    finishes = 0;
  const lifetime = createBackgroundOwnerLifecycle({
    requested() {},
    prepareStop: async () => {},
    stopWriter: async () => {
      stops++;
    },
    release: async () => {
      releases++;
      if (releases === 1) throw new Error("private release failure");
    },
    finish: async () => {
      finishes++;
    },
    failed() {},
  });
  lifetime.own(() => {
    disposals++;
  });
  const initializing = lifetime.initialize(async () => {
    await acquisition;
  });
  const first = lifetime.stop();
  init();
  await assert.rejects(first);
  await assert.rejects(initializing);
  await lifetime.stop();
  await lifetime.stop();
  assert.deepEqual(
    { releases, disposals, stops, finishes },
    { releases: 2, disposals: 1, stops: 1, finishes: 1 },
  );
  passed.push(
    "failed cleanup retry resumes incomplete stage without poisoned stopPending/double disposal or writer restart",
  );
  console.log(JSON.stringify({ checks: passed.length, passed }, null, 2));
} finally {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      child.kill("SIGKILL");
      await exited;
    }),
  );
  await rm(root, { recursive: true, force: true });
}
