import { execFile } from "node:child_process";
import { win32 } from "node:path";
import type { IndependentBackgroundState } from "@pibot/protocol";
import { z } from "zod";

type Management = IndependentBackgroundState["management"];
type Operation = "query" | "register" | "disable" | "unregister";
const Result = z.strictObject({ registered: z.boolean(), enabled: z.boolean() });

/** Fixed operations over this installation's task; arguments are data, not PowerShell source. */
export function windowsBackgroundTaskScript(options: {
  label: string;
  executable: string;
  operation: Operation;
}) {
  if (!/^[a-z0-9.]{1,100}$/.test(options.label) || !win32.isAbsolute(options.executable))
    throw new Error("background_task_identity_invalid");
  const payload = Buffer.from(JSON.stringify(options), "utf8").toString("base64");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "if ($sid -eq 'S-1-5-18' -or $sid -eq 'S-1-5-19' -or $sid -eq 'S-1-5-20') { throw 'user_required' }",
    "$marker = 'Pi Bot current-user background v1'",
    "function Read-Task {",
    "  try { return Get-ScheduledTask -TaskName $p.label -TaskPath '\\' -ErrorAction Stop }",
    "  catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound' -and $_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return $null }; throw }",
    "}",
    "function To-Sid($value) { if ($value -match '^S-1-') { return $value }; return [Security.Principal.NTAccount]::new($value).Translate([Security.Principal.SecurityIdentifier]).Value }",
    "function Assert-Task($task) {",
    "  if (-not $task) { throw 'task_missing' }",
    "  if ((To-Sid $task.Principal.UserId) -ne $sid -or $task.Principal.LogonType -ne 'Interactive' -or $task.Principal.RunLevel -ne 'Limited' -or $task.Description -ne $marker) { throw 'task_identity_unknown' }",
    "  if (@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine $p.executable -or $task.Actions[0].Arguments -cne '--pibot-background' -or $task.Actions[0].WorkingDirectory) { throw 'task_action_unknown' }",
    "  if (@($task.Triggers).Count -ne 1 -or $task.Triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or (To-Sid $task.Triggers[0].UserId) -ne $sid -or -not $task.Triggers[0].Enabled -or ($task.Triggers[0].Repetition.Interval -and $task.Triggers[0].Repetition.Interval -ne 'PT0S') -or ($task.Triggers[0].Delay -and $task.Triggers[0].Delay -ne 'PT0S')) { throw 'task_trigger_unknown' }",
    "  if ($task.Settings.RestartCount -ne 0 -or $task.Settings.MultipleInstances -ne 'IgnoreNew' -or $task.Settings.ExecutionTimeLimit -ne 'PT0S' -or -not $task.Settings.Hidden) { throw 'task_settings_unknown' }",
    "}",
    "$task = Read-Task",
    "if ($task) { Assert-Task $task }",
    "if ($p.operation -eq 'register') {",
    "  $created = $false",
    "  $wasEnabled = [bool]($task -and $task.Settings.Enabled)",
    "  try {",
    "    if ($task) { Enable-ScheduledTask -TaskName $p.label -TaskPath '\\' | Out-Null }",
    "    else {",
    "      $action = New-ScheduledTaskAction -Execute $p.executable -Argument '--pibot-background'",
    "      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid",
    "      $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited",
    "      $settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)",
    "      $definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $marker",
    "      Register-ScheduledTask -TaskName $p.label -TaskPath '\\' -InputObject $definition | Out-Null",
    "      $created = $true",
    "    }",
    "    $verified = Read-Task",
    "    Assert-Task $verified",
    "    if (-not $verified.Settings.Enabled) { throw 'task_registration_unconfirmed' }",
    "  } catch {",
    "    $restore = Read-Task",
    "    if ($restore) { Assert-Task $restore }",
    "    if ($created -and $restore) { Unregister-ScheduledTask -TaskName $p.label -TaskPath '\\' -Confirm:$false; if (Read-Task) { throw 'task_rollback_unconfirmed' } }",
    "    elseif ($task -and -not $wasEnabled -and $restore) { Disable-ScheduledTask -TaskName $p.label -TaskPath '\\' | Out-Null; $restore = Read-Task; Assert-Task $restore; if ($restore.Settings.Enabled) { throw 'task_rollback_unconfirmed' } }",
    "    throw 'task_registration_failed'",
    "  }",
    "} elseif ($p.operation -eq 'disable' -and $task) {",
    "  Disable-ScheduledTask -TaskName $p.label -TaskPath '\\' | Out-Null",
    "} elseif ($p.operation -eq 'unregister' -and $task) {",
    "  Unregister-ScheduledTask -TaskName $p.label -TaskPath '\\' -Confirm:$false",
    "} elseif ($p.operation -ne 'query' -and $p.operation -ne 'disable' -and $p.operation -ne 'unregister') { throw 'operation_invalid' }",
    "$actual = Read-Task",
    "if ($actual) { Assert-Task $actual }",
    "@{ registered = [bool]$actual; enabled = [bool]($actual -and $actual.Settings.Enabled) } | ConvertTo-Json -Compress",
  ].join("\n");
}

export function createWindowsBackgroundTask(options: {
  label: string;
  executable: string;
  systemRoot: string | undefined;
  packaged: boolean;
  loginItemsEnabled: boolean;
  execute?: (script: string, signal: AbortSignal) => Promise<string>;
}) {
  const unavailable = (reason: Management["reason"]): Management => ({
    kind: "task-scheduler",
    available: false,
    registered: null,
    enabled: null,
    reason,
  });
  const reason = () =>
    !options.packaged
      ? "unpackaged"
      : !options.loginItemsEnabled
        ? "data_dir"
        : !options.systemRoot || !win32.isAbsolute(options.systemRoot)
          ? "manager_unavailable"
          : undefined;
  const execute =
    options.execute ??
    ((script: string, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        const root = options.systemRoot;
        if (!root || !win32.isAbsolute(root)) {
          reject(new Error("background_manager_unavailable"));
          return;
        }
        execFile(
          win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          { signal, timeout: 10_000, maxBuffer: 4096, windowsHide: true, encoding: "utf8" },
          (error, stdout) =>
            error ? reject(new Error("background_manager_failed")) : resolve(stdout),
        );
      }));
  const run = async (operation: Operation, signal: AbortSignal) => {
    signal.throwIfAborted();
    const unsupported = reason();
    if (unsupported) throw new Error(`background_management_${unsupported}`);
    const result = Result.parse(
      JSON.parse(
        await execute(
          windowsBackgroundTaskScript({
            label: options.label,
            executable: options.executable,
            operation,
          }),
          signal,
        ),
      ),
    );
    signal.throwIfAborted();
    if (
      (operation === "register" && (!result.registered || !result.enabled)) ||
      (operation === "disable" && result.enabled) ||
      (operation === "unregister" && result.registered)
    )
      throw new Error("background_registration_unconfirmed");
    return result;
  };
  return {
    async query(): Promise<Management> {
      const unsupported = reason();
      if (unsupported) return unavailable(unsupported);
      try {
        return {
          kind: "task-scheduler",
          available: true,
          ...(await run("query", AbortSignal.timeout(10_000))),
          reason: "available",
        };
      } catch {
        return unavailable("query_failed");
      }
    },
    async register(signal: AbortSignal) {
      await run("register", signal);
    },
    async disableLogin(signal: AbortSignal) {
      await run("disable", signal);
    },
    async unregister(signal: AbortSignal) {
      await run("unregister", signal);
    },
  };
}
