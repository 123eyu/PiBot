import { resolve } from "node:path";
import {
  BinaryPublicationError,
  ExecError,
  GitOutputSourceError,
  gitOutputIntent,
  prepareGitOutput,
} from "@pibot/execution";
import type { AuditDetail } from "@pibot/protocol-base";
import type { RunCommandArgs } from "@pibot/tools/command";
import type { PreparedTool } from "../../core/local-types.ts";
import type { LocalRun } from "./local-run.ts";

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const sourceFailure = (error: GitOutputSourceError) => ({
  isError: true,
  text:
    error.scope === "object_limit"
      ? "未导出：源 Git 对象库的实体/nlink 安全检查达到保护上限；目标项目整树没有扫描。此通道不绕过大型对象库限制；不要换写声明盲重试。请使用较小的已授权参考仓库，或让用户维护源对象库。 / Not exported: source Git object identity/nlink validation reached its budget. The destination project was not scanned. This path retains large-object-store limits; do not blindly retry with changed declarations. Use a smaller authorized reference repository or ask the user to maintain the source object store."
      : "未导出：源 Git 对象布局不支持（别名/硬链接、alternates/promisor、shallow/grafts/replace 或未知对象入口）。没有获得执行这些配置的权限。 / Not exported: unsupported source Git object layout (aliases/hardlinks, alternates/promisor, shallow/grafts/replace or unknown entries). No authority to execute those configurations was granted.",
});
const unsupported = () => ({
  isError: true,
  text: "未执行：精确 Git 输出仅支持本机隔离前台的commit-only diff/show（完整 OID）或 fullOID..fullOID 的 format-patch --stdout，须含 --no-pager、--no-replace-objects、--attr-source=<空 tree 完整 OID>、--no-ext-diff、--no-textconv、--no-color，用 > 写入父目录已存在的新文件；不支持追加、覆盖、额外写声明、后台、Docker、远端或Linux显式只读/deny根。请先单独只读解析完整 commit OID，再提交原文安全导出命令，保留真实写声明。SHA-1 仓库的空 tree OID 为 4b825dc642cb6eb9a060e54bf8d69288fbee4904；例如 git --no-pager --no-replace-objects --attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904 diff --no-ext-diff --no-textconv --no-color <完整旧OID> <完整新OID> > <新文件绝对路径>。私有 bare 视图不加载项目/全局/系统配置或工作树属性；HEAD、分支和路径不支持。 / Not executed: exact Git output requires a local isolated foreground commit-only diff/show with full OIDs or format-patch --stdout fullOID..fullOID, with --no-pager, --no-replace-objects, --attr-source=<full empty-tree OID>, --no-ext-diff, --no-textconv and --no-color, and > to a new file in an existing directory. Append, overwrite, extra write declarations, background, Docker, remote targets and explicit readonly/deny roots on Linux are unsupported. Resolve full commit OIDs with a separate readonly query first, then submit the exact safe export command; retain real write declarations. The SHA-1 empty-tree OID is 4b825dc642cb6eb9a060e54bf8d69288fbee4904; the example above uses full old/new OIDs and a new absolute output path. The private bare view ignores project/global/system config and worktree attributes; HEAD, branches and paths are unsupported.",
});

/** Select storage only after policy authorized the entire unchanged command and all its writes. */
export async function executeGitOutput(
  run: LocalRun,
  prepared: PreparedTool,
  args: RunCommandArgs,
  fields: AuditDetail,
  signal: AbortSignal,
  output: (text: string) => void,
) {
  const analysis = prepared.result.analysis;
  const redirect = analysis?.literalOutputRedirect;
  if (
    !redirect &&
    analysis?.fileRedirect &&
    analysis.commands.length === 1 &&
    /(?:^|\/)git$/.test(analysis.commands[0]?.program ?? "") &&
    analysis.commands[0]?.args.some((arg) => ["diff", "show", "format-patch"].includes(arg))
  )
    return unsupported();
  if (
    !redirect ||
    !/^(?:git|\/(?:usr\/bin|bin|usr\/local\/bin|opt\/homebrew\/bin)\/git)$/.test(
      redirect.command.program,
    )
  )
    return;
  const subcommand = redirect.command.args.find((arg) => !arg.startsWith("-"));
  if (!["diff", "show", "format-patch"].includes(subcommand ?? "")) return;
  const intent = gitOutputIntent(redirect.command.program, redirect.command.args);
  if (!intent) return unsupported();
  const target = resolve(prepared.cwd, redirect.path);
  if (
    redirect.operator !== ">" ||
    analysis?.incomplete ||
    analysis.network ||
    analysis.commands.length !== 1 ||
    analysis.writes.length !== 1 ||
    analysis.writes[0] !== target ||
    args.writePaths?.some((path) => path !== target) ||
    args.background ||
    prepared.docker ||
    prepared.gitConfiguration ||
    prepared.gitHook ||
    prepared.hostSsh ||
    prepared.secretUses?.length ||
    (prepared.boundary?.location?.target ?? "local") !== "local" ||
    (run.local.deps.platform === "linux" &&
      (prepared.boundary?.denyWriteRoots.length ||
        prepared.boundary?.roots.some((root) => root.role === "readonly"))) ||
    !["darwin", "linux"].includes(run.local.deps.platform)
  )
    return unsupported();
  const command = [redirect.command.program, ...redirect.command.args].map(quote).join(" ");
  const body = (await run.local.getPolicy(signal)).analyzeCommand(command);
  if (
    !body.literalCommand ||
    !body.readonly ||
    body.incomplete ||
    body.network ||
    body.writes.length
  )
    return unsupported();
  run.assertDispatch(prepared);
  if (!(await run.target.isolationStatus(signal)).available) return unsupported();
  let refusal: ReturnType<typeof sourceFailure> | undefined;
  const plan = await prepareGitOutput({
    command: args.command,
    program: redirect.command.program,
    args: redirect.command.args,
    path: target,
    expectedPath: target,
    cwd: prepared.cwd,
    rootIdentities: prepared.boundary?.roots,
    writeRoots: run.writeRoots(prepared),
    denyWriteRoots: prepared.boundary?.denyWriteRoots,
    signal,
    platform: run.local.deps.platform,
    assertCurrent: () => run.assertDispatch(prepared),
    revalidate: () => run.assertDispatch(prepared),
  }).catch((error: unknown) => {
    if (error instanceof GitOutputSourceError) {
      refusal = sourceFailure(error);
      return undefined;
    }
    if (
      error instanceof ExecError &&
      ["file_conflict", "invalid_input", "git_unavailable"].includes(error.code)
    )
      return undefined;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!plan) return refusal ?? unsupported();
  run.clearCommandChecks();
  await run.watchCommandRoots(prepared);
  const audit = {
    ...fields,
    toolCallId: prepared.call.id,
    command: fields.target,
    reasonCode: "git_output_new_file",
  };
  run.auditCommand("started", "Git output started / 开始导出Git输出", audit);
  let applied: { path: string; bytes: number; revision: string } | undefined;
  try {
    const result = await run.target.runCommand({
      command: args.command,
      cwd: prepared.cwd,
      dataDir: run.local.deps.dataDir,
      botHome: prepared.home,
      runId: run.context.runId,
      writeRoots: [],
      rootIdentities: prepared.boundary?.roots,
      denyWriteRoots: prepared.boundary?.denyWriteRoots,
      network: { allowAll: false, domains: [] },
      pathEntries: prepared.settings.pathEntries,
      timeoutSec: args.timeoutSec,
      signal,
      onOutput: output,
      gitOutput: plan,
      assertAuthorized: () => run.assertDispatch(prepared),
    });
    applied = result.outputFile;
    const success = !!applied && result.exitCode === 0 && !result.stopped && !result.timedOut;
    const audited = finishAudit(run, audit, success, result.exitCode, applied);
    return {
      isError: !success,
      text: applied
        ? `${success ? "" : "文件已创建但收尾未确认，不要自动重试或覆盖。 / File created but completion is unconfirmed. Do not automatically replay or overwrite.\n"}已用私有对象视图导出新文件 / Exported new file using private object view: ${applied?.path}\n${applied?.bytes} bytes; SHA256 ${applied?.revision}`
        : `${result.truncatedOutput}\n未发布输出文件 / Output file not published. Exit: ${result.exitCode ?? "unknown"}`,
      untrustedContent: !success && !!result.truncatedOutput,
      details: {
        exitCode: applied && !success ? null : result.exitCode,
        durationMs: result.durationMs,
        logPath: result.logPath,
        timedOut: result.timedOut,
        stopped: result.stopped,
        ...(applied ? { outputFile: applied } : {}),
        ...(audited ? {} : { audit: "unconfirmed" }),
      },
    };
  } catch (error) {
    if (error instanceof BinaryPublicationError) applied = error.publication;
    finishAudit(run, audit, false, null, applied);
    if (!applied && error instanceof GitOutputSourceError) return sourceFailure(error);
    if (applied)
      return {
        isError: true,
        text: `文件已经发布，收尾未确认；不要自动重试或覆盖。 / File was published; cleanup is unconfirmed. Do not automatically replay or overwrite.\n${applied.path}\n${applied.bytes} bytes; SHA256 ${applied.revision}`,
        details: {
          errorCode: "output_publication_unconfirmed",
          exitCode: null,
          outputFile: applied,
          publication: "unconfirmed",
        },
      };
    throw error;
  }
}
function finishAudit(
  run: LocalRun,
  fields: AuditDetail,
  success: boolean,
  exitCode: number | null,
  publication: { bytes: number; revision: string } | undefined,
) {
  try {
    run.auditCommand("finished", "Git output finished / Git输出已结束", {
      ...fields,
      exitCode,
      reasonCode: success ? "git_output_published" : "git_output_failed",
      ...(publication ? { sourceDigest: publication.revision } : {}),
    });
    return true;
  } catch {
    // A completed publication must never become an automatic command replay on audit failure.
    run.local.deps.logger.warn(
      JSON.stringify({
        module: "git-output",
        event: "completion_audit_failed",
        runId: run.context.runId,
      }),
    );
    return false;
  }
}
