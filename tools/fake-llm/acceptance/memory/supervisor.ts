import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { Options } from "./options.ts";

/** Only certified Worker exit permits deletion: no model or SQLite handle can still use the root. */
export async function supervise(o: Options, argv: string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-memory-acceptance-")));
  const keep = Boolean(process.env.PIBOT_EVAL_KEEP);
  let worker: Worker | undefined;
  let exited = false;
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const name of [
      "HOME",
      "USERPROFILE",
      "PATH",
      "TMPDIR",
      "TMP",
      "TEMP",
      "SystemRoot",
      "WINDIR",
    ])
      if (process.env[name] !== undefined) env[name] = process.env[name];
    if (o.real) env.PIBOT_EVAL_API_KEY = o.key;
    worker = new Worker(new URL("./index.ts", import.meta.url), {
      workerData: { root },
      argv,
      execArgv: [],
      env,
      stdout: true,
      stderr: true,
    });
    o.key = undefined;
    // SDK stderr may contain provider payloads; only deliberate structural reports cross over.
    worker.stdout.resume();
    worker.stderr.resume();
    const runner = worker;
    return await new Promise<number>((resolve, reject) => {
      let result: number | undefined;
      let stopping = false;
      let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      const seen = new Set<number>();
      const stop = () => {
        if (stopping || exited) return;
        stopping = true;
        console.error("FAIL memory: 已取消、超时或执行者异常，正在清理");
        terminationTimer = setTimeout(() => {
          clearTimeout(deadline);
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          runner.unref();
          reject(new Error("worker_exit_unconfirmed"));
        }, 10_000);
        void runner.terminate().catch(() => {
          /* The exit deadline reports unconfirmed shutdown. */
        });
      };
      const deadline = setTimeout(stop, o.timeoutMs * 10 + 180_000);
      runner.on("message", (raw: unknown) => {
        if (!raw || typeof raw !== "object") return stop();
        const message = raw as { type?: unknown; line?: unknown; code?: unknown };
        if (
          message.type === "line" &&
          typeof message.line === "string" &&
          /^(ok|FAIL) (?:[1-9]|10) [^\r\n]{1,3000}$/u.test(message.line)
        ) {
          const n = Number(message.line.split(" ")[1]);
          if (seen.has(n)) return stop();
          seen.add(n);
          console.log(message.line);
        } else if (
          message.type === "done" &&
          (message.code === 0 || message.code === 1) &&
          result === undefined
        )
          result = message.code;
        else stop();
      });
      runner.once("error", stop);
      runner.once("exit", (code) => {
        exited = true;
        clearTimeout(deadline);
        clearTimeout(terminationTimer);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        if (stopping || code !== 0 || result === undefined || seen.size !== 10) resolve(1);
        else resolve(result);
      });
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  } finally {
    // Same switch as `pnpm eval roles`: a real-model failure is only diagnosable from its data.
    if (keep) console.error(`memory: 保留临时目录 ${root}`);
    else if (!worker || exited) await rm(root, { recursive: true, force: true });
    else console.error("FAIL memory: 未确认执行者退出，保留临时目录供清理");
  }
}
