import { BrowserSecretHandleSchema } from "@pibot/protocol-base";
import type { RunCommandArgs } from "@pibot/tools/command";
import { z } from "zod";

const posixAbsolute = String.raw`/[^\x00-\x1f]*`;
const windowsPart = String.raw`[^\\/\x00-\x1f<>:"|?*]+`;
const uncPart = String.raw`(?!\.{1,2}(?:[\\/]|$))${windowsPart}`;
const windowsTail = String.raw`[^\x00-\x1f<>:"|?*]*`;
const windowsAbsolute = String.raw`(?:[A-Za-z]:[\\/]${windowsTail}|\\\\${uncPart}\\${uncPart}(?:\\${windowsTail})?|//${uncPart}/${uncPart}(?:/${windowsTail})?)`;
const posixPattern = new RegExp(`^(?:${posixAbsolute})$`);
const windowsPattern = new RegExp(`^(?:${windowsAbsolute})$`);
const absolutePattern = new RegExp(`^(?:${posixAbsolute}|${windowsAbsolute})$`);

export const COMMAND_INPUT_GUIDANCE =
  '命令参数无效：cwd 只选择执行目录，不授予写权限。writePaths 仅声明实际写入的绝对路径（最多 8 个）；只读查询请省略或传 []，不要传“忽略”等相对占位。Windows 使用盘符绝对路径或完整 UNC，不接受 C:foo 或仅以反斜线开头的路径。保留真正需要写入的目标，纠正后重走权限校验；这不是权限设置错误 / Invalid command arguments: cwd selects the execution directory, not write permission. writePaths declares actual absolute write targets (at most 8); omit it or use [] for a read-only query, never relative placeholders such as "ignore". Windows requires a drive-absolute path or complete UNC, not C:foo or a single-rooted backslash path. Keep real write targets and retry through permission checks; this is not a permission-setting error';

/** SDK validation checks portable syntax; the resolved target is checked before policy. */
export const RunCommandInputSchema = z.strictObject({
  command: z.string().min(1).max(65_536),
  env: z
    .record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), BrowserSecretHandleSchema)
    .refine((env) => Object.keys(env).length > 0 && Object.keys(env).length <= 16)
    .optional(),
  cwd: z.string().min(1).max(32_768).optional(),
  timeoutSec: z.number().int().min(1).max(600).optional(),
  background: z.boolean().optional(),
  docker: z.boolean().optional(),
  writePaths: z.array(z.string().min(1).max(32_768).regex(absolutePattern)).max(8).optional(),
  outsideSandbox: z.literal(true).optional(),
});

export class CommandInputError extends Error {
  readonly validation: z.ZodError;
  constructor(indices: number[]) {
    super("command_write_path_absolute");
    this.validation = new z.ZodError(
      indices.map((index) => ({
        code: "custom" as const,
        path: ["writePaths", index],
        message: "command_write_path_absolute",
      })),
    );
  }
}

/** A host-absolute path can be relative on a runner; never reinterpret its write declaration. */
export function assertCommandWritePaths(args: RunCommandArgs, platform: NodeJS.Platform): void {
  const pattern = platform === "win32" ? windowsPattern : posixPattern;
  const indices = (args.writePaths ?? []).flatMap((path, index) =>
    pattern.test(path) ? [] : [index],
  );
  if (indices.length) throw new CommandInputError(indices);
}
