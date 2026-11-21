import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fail, projectRoot } from "./process.ts";

/**
 * A and B comparison for prompt changes: same task set, one conversation each, then a table.
 * The model calls are made by `pibot run` (which needs a real provider); this file only drives it,
 * parses the JSON lines and adds up the numbers. Nothing here reaches the network by itself.
 */
const USAGE = `用法 / usage:
  pnpm eval run   --suite <file.json> --data <dir> --out <dir> [--group name] [--limit N] [--only a,b] [provider flags]
  pnpm eval report <dir> [<dir> ...]

provider flags: --base-url <url> --model <id> --api <provider>
密钥走环境变量 PIBOT_EVAL_API_KEY，不放命令行（会进 shell 历史和进程列表）。`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    suite: { type: "string" },
    data: { type: "string" },
    out: { type: "string" },
    group: { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
    api: { type: "string" },
    timeout: { type: "string" },
    limit: { type: "string" },
    only: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [mode, ...rest] = positionals;

try {
  if (values.help === true || mode === undefined) {
    console.log(USAGE);
  } else if (mode === "run") await runSuite();
  else if (mode === "report") report(rest.length ? rest : []);
  else fail(`未知命令 / unknown command: ${mode}\n\n${USAGE}`);
} catch (error) {
  fail(error);
  process.exitCode = 1;
}

function parseSuite(suitePath: string): Task[] {
  const text = readFileSync(resolve(suitePath), "utf8");
  try {
    return JSON.parse(text) as Task[];
  } catch {
    // The usual cause is a copy that put a .ts file where the suite should be; quote it back.
    throw new Error(
      `任务集不是合法 JSON / not valid JSON: ${suitePath}\n  开头 / starts with: ${JSON.stringify(text.slice(0, 40))}`,
    );
  }
}

type Task = { id: string; category: string; prompt: string; checks?: string[] };

async function runSuite() {
  const suitePath = require(values.suite, "--suite");
  const dataDir = resolve(require(values.data, "--data"));
  const outDir = resolve(require(values.out, "--out"));
  const group = values.group ?? "run";
  const apiKey = process.env.PIBOT_EVAL_API_KEY;
  if (!apiKey) throw new Error("缺少 PIBOT_EVAL_API_KEY / missing PIBOT_EVAL_API_KEY");
  if (!values["base-url"] || !values.model)
    throw new Error("缺少 --base-url 或 --model / missing --base-url or --model");

  const all: Task[] = parseSuite(suitePath);
  let tasks = all;
  if (!Array.isArray(tasks) || !tasks.length) throw new Error("任务集为空 / empty suite");
  if (values.only) {
    const ids = values.only
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const known = new Set(tasks.map((task) => task.id));
    const missing = ids.filter((id) => !known.has(id));
    // A typo would otherwise run zero tasks and look like a clean, empty report.
    if (!ids.length || missing.length)
      throw new Error(`--only 未知任务 / unknown task: ${missing.join(",") || "(empty)"}`);
    tasks = ids.map((id) => tasks.find((task) => task.id === id) as Task);
  }
  if (values.limit) {
    // A two-task trial run keeps a broken provider or bad key from burning the whole budget.
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("--limit 必须是正整数 / --limit must be positive");
    tasks.splice(limit);
  }
  if (tasks.length > 20) throw new Error("任务集上限 20 条 / at most 20 tasks");
  // Compiling every pattern up front keeps a typo in the suite from wasting a paid run.
  for (const task of tasks) for (const pattern of task.checks ?? []) new RegExp(pattern);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  console.log(`任务集 ${tasks.length} 条，组 ${group}，数据目录 ${dataDir}`);
  let failed = 0;
  for (const [index, task] of tasks.entries()) {
    const file = join(outDir, `${group}-${String(index + 1).padStart(2, "0")}-${task.id}.jsonl`);
    const args = [
      "apps/cli/bin/pibot.mjs",
      "run",
      "--data",
      dataDir,
      `--message=${task.prompt}`,
      "--base-url",
      values["base-url"],
      "--model",
      values.model,
      "--json",
    ];
    if (values.api) args.push("--api", values.api);
    if (values.timeout) args.push("--timeout", values.timeout);
    // Same conversation across tasks: that is what makes cache reads comparable turn to turn.
    // `--message=` because a prompt may start with "-" and strict parsing rejects a lone flag.
    const result = await call(args, apiKey, (Number(values.timeout ?? 600) + 60) * 1000);
    if (result.code !== 0 && result.stderr)
      console.log(`  stderr: ${result.stderr.split("\n").filter(Boolean).at(-1)}`);
    const turn = parseLines(result.lines);
    const verdict = judge(task, turn);
    // report() has no suite to check against, and "answered" is not "correct", so the verdict is
    // written next to the raw lines and read back later.
    const record = JSON.stringify({
      type: "eval",
      task: task.id,
      group,
      verdict,
      exit: result.code,
    });
    writeFileSync(file, `${[...result.lines, record].join("\n")}\n`);
    if (verdict !== "pass") failed++;
    console.log(
      `${task.id.padEnd(10)} exit=${result.code} ${verdict === "pass" ? "pass" : `FAIL(${verdict})`} input=${turn.input} cacheRead=${turn.cacheRead} first=${turn.firstTokenMs ?? "-"}ms`,
    );
  }
  if (failed) {
    // A failing suite must stop a scripted run (--trial) instead of spending the rest of the budget.
    console.log(`\n${failed}/${tasks.length} 条未通过 / failed`);
    process.exitCode = 1;
  }
}

function judge(task: Task, turn: Turn): string {
  if (turn.status !== "done") return turn.error ?? "no_done";
  if (!turn.text.trim()) return "empty";
  const missing = (task.checks ?? []).filter(
    (pattern) => !new RegExp(pattern, "i").test(turn.text),
  );
  return missing.length ? `missing:${missing.join("|")}` : "pass";
}

function call(args: string[], apiKey: string, hardMs: number) {
  return new Promise<{ code: number; lines: string[]; stderr: string }>((done, reject) => {
    // The key is the one variable the child needs: leaving the eval ones in place would hand them
    // to the brain, to a Bot's commands and to anything they start.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ["PIBOT_EVAL_API_KEY", "OPENROUTER_API_KEY", "PIBOT_API_KEY"])
      delete env[name];
    env.PIBOT_API_KEY = apiKey;
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      // The key reaches the child through its environment, never through argv.
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    const push = (line: string) => {
      if (line.trim()) lines.push(line);
    };
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      // A long answer splits its JSON line across chunks; only whole lines can be parsed.
      const parts = (pending + chunk).split("\n");
      pending = parts.pop() ?? "";
      for (const line of parts) push(line);
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2000);
    });
    // A wedged provider would otherwise hold the whole suite: the run's own limit plus a margin.
    const killer = setTimeout(() => {
      stderr += "\n(eval: child killed after the hard timeout)";
      child.kill("SIGKILL");
    }, hardMs);
    child.once("error", (error) => {
      clearTimeout(killer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(killer);
      push(pending);
      done({ code: code ?? 1, lines, stderr });
    });
  });
}

type Turn = {
  status: string;
  text: string;
  error?: string;
  verdict?: string;
  group?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  firstTokenMs: number | null;
  totalMs: number | null;
};

function parseLines(lines: string[]): Turn {
  const turn: Turn = {
    status: "none",
    text: "",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    firstTokenMs: null,
    totalMs: null,
  };
  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type === "error") {
      turn.status = "error";
      turn.error = String(record.code ?? "error");
    }
    if (record.type === "eval") {
      // Written by `run`, so a report can tell "answered" from "passed" and group names may contain
      // dashes (the file name alone cannot carry that).
      if (typeof record.verdict === "string") turn.verdict = record.verdict;
      if (typeof record.group === "string") turn.group = record.group;
    }
    if (record.type !== "done") continue;
    turn.status = String(record.status ?? "done");
    turn.text = String(record.text ?? "");
    const usage = (record.usage ?? {}) as Record<string, unknown>;
    turn.input = num(usage.input);
    turn.output = num(usage.output);
    turn.cacheRead = num(usage.cacheRead);
    turn.cacheWrite = num(usage.cacheWrite);
    const timing = (record.timing ?? {}) as Record<string, unknown>;
    turn.firstTokenMs = typeof timing.firstTokenMs === "number" ? timing.firstTokenMs : null;
    turn.totalMs = typeof timing.totalMs === "number" ? timing.totalMs : null;
  }
  return turn;
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function report(dirs: string[]) {
  if (!dirs.length)
    throw new Error(`报告需要至少一个结果目录 / report needs a directory\n\n${USAGE}`);
  const groups = new Map<string, Turn[]>();
  for (const dir of dirs) {
    const root = resolve(dir);
    if (!existsSync(root)) throw new Error(`目录不存在 / no such directory: ${root}`);
    for (const name of readdirSync(root)
      .filter((file) => file.endsWith(".jsonl"))
      .sort()) {
      const turn = parseLines(
        readFileSync(join(root, name), "utf8")
          .split("\n")
          .filter((line) => line.trim()),
      );
      // The suite's own record names the group; only older files fall back to the file name.
      const group = turn.group ?? name.split("-")[0] ?? "run";
      const list = groups.get(group) ?? [];
      list.push(turn);
      groups.set(group, list);
    }
  }
  // "before" first so the arrow in the summary reads in time order, not alphabetically.
  if (!groups.size)
    throw new Error(
      `这些目录里没有结果文件 / no .jsonl results in ${dirs.join(", ")}\n先跑 pnpm eval run 生成结果（文件名形如 before-01-short-1.jsonl）。`,
    );
  const order = ["before", "after"];
  const rows = [...groups.entries()]
    .sort(([left], [right]) => order.indexOf(left) - order.indexOf(right))
    .map(([group, turns]) => summarize(group, turns));
  console.log(
    "组        任务  成功  input    cacheRead  命中%  缓存写入  首字p50  首字均值  总时均值",
  );
  for (const row of rows) {
    console.log(
      `${row.group.padEnd(8)} ${String(row.tasks).padStart(5)} ${String(row.passed).padStart(4)} ${String(row.input).padStart(8)} ${String(row.cacheRead).padStart(10)} ${row.hitRate.toFixed(2).padStart(6)} ${String(row.cacheWrite).padStart(9)} ${String(row.firstP50 ?? "-").padStart(8)} ${String(row.firstMean ?? "-").padStart(9)} ${String(row.totalMean ?? "-").padStart(9)}`,
    );
  }
  if (rows.length === 2) {
    const [a, b] = rows as [Row, Row];
    console.log(
      `\n${a.group} → ${b.group}：命中率 ${a.hitRate.toFixed(2)}% → ${b.hitRate.toFixed(2)}%，成功率 ${a.passed}/${a.tasks} → ${b.passed}/${b.tasks}`,
    );
  }
  console.log(JSON.stringify(rows, null, 2));
}

type Row = {
  group: string;
  tasks: number;
  passed: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  hitRate: number;
  firstP50: number | null;
  firstMean: number | null;
  totalMean: number | null;
};

function summarize(group: string, turns: Turn[]): Row {
  const input = sum(turns, (turn) => turn.input);
  const cacheRead = sum(turns, (turn) => turn.cacheRead);
  // Failed turns report no timing; counting them as 0 would flatter the average.
  const answered = turns.filter((turn) => turn.status === "done" && turn.text.trim());
  const firsts = answered.flatMap((turn) =>
    turn.firstTokenMs === null ? [] : [turn.firstTokenMs],
  );
  const totals = answered.flatMap((turn) => (turn.totalMs === null ? [] : [turn.totalMs]));
  return {
    group,
    tasks: turns.length,
    // "Answered" is not "correct": the suite's verdict decides, and older files fall back to it.
    passed: turns.filter((turn) =>
      turn.verdict ? turn.verdict === "pass" : turn.status === "done" && turn.text.trim() !== "",
    ).length,
    input,
    output: sum(turns, (turn) => turn.output),
    cacheRead,
    cacheWrite: sum(turns, (turn) => turn.cacheWrite),
    // Prompt tokens served from cache; the rest was read in full.
    hitRate: input + cacheRead > 0 ? (cacheRead / (input + cacheRead)) * 100 : 0,
    firstP50: percentile(firsts, 0.5),
    firstMean: mean(firsts),
    totalMean: mean(totals),
  };
}

function sum(turns: Turn[], pick: (turn: Turn) => number) {
  return turns.reduce((total, turn) => total + pick(turn), 0);
}

function mean(values: number[]) {
  if (!values.length) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function percentile(values: number[], at: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] ?? 0);
}

function require(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`缺少 ${flag} / missing ${flag}`);
  return value;
}
