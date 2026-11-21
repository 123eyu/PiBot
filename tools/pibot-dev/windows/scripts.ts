import { ownership } from "./cleanup-script.ts";
import { header, ps } from "./script-base.ts";
import type { WindowsCheck } from "./types.ts";

const windowTaskCleanup = `
function StopWindowTask {
  AssertOwned
  $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $taskName })
  if ($tasks.Count -gt 1) { throw 'task_identity' }
  if (-not $tasks.Count) { return }
  Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
  Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $until = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $taskName })
    if ($tasks.Count -gt 1) { throw 'task_identity' }
    if ($tasks.Count -eq 1 -and $tasks[0].State -in @('Ready','Disabled')) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $until)
  throw 'observer_stop_unconfirmed'
}
function CleanupWindowTest {
  if (-not (Test-Path -LiteralPath $root)) { Cleanup; return }
  AssertOwned
  # Quiesce deployment before stopping a task it could otherwise register/start after our check.
  StopWorker
  StopWindowTask
  $owner = Get-Content -Raw -LiteralPath (Join-Path $root 'owner.json') | ConvertFrom-Json
  StopNative $owner
  Cleanup
}
`;

function windowObserver(runId: string, root: string, artifactHash: string) {
  return `${header(runId)}
$root = ${ps(root)}
$expectedHash = ${ps(artifactHash)}
${String.raw`
function WindowOwner {
  if ([IO.Path]::GetFileName($root) -ne ('pibot-dev-' + $runId)) { throw 'identity' }
  $directory = Get-Item -LiteralPath $root -Force -ErrorAction Stop
  $file = Get-Item -LiteralPath (Join-Path $root 'owner.json') -Force -ErrorAction Stop
  if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -gt 4096) { throw 'identity' }
  $owner = [IO.File]::ReadAllText($file.FullName) | ConvertFrom-Json
  if ($owner.runId -cne $runId -or $owner.artifactHash -cne $expectedHash) { throw 'identity' }
  return $owner
}
$owner = WindowOwner
$self = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID) -ErrorAction Stop
$observer = Get-Process -Id $PID -ErrorAction Stop
try { $session = $observer.SessionId } finally { $observer.Dispose() }
if (-not [Environment]::UserInteractive -or $session -le 0 -or -not $self) { throw 'interactive_session' }
$owner | Add-Member -NotePropertyName nativePid -NotePropertyValue $PID -Force
$owner | Add-Member -NotePropertyName nativeCreated -NotePropertyValue $self.CreationDate.ToUniversalTime().ToString('O') -Force
$owner | Add-Member -NotePropertyName nativePath -NotePropertyValue $self.ExecutablePath -Force
$ownerTemp = Join-Path $root 'window-owner.tmp'
$ownerBytes = [Text.UTF8Encoding]::new($false).GetBytes(($owner | ConvertTo-Json -Compress))
$stream = [IO.File]::Open($ownerTemp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $stream.Write($ownerBytes, 0, $ownerBytes.Length); $stream.Flush() } finally { $stream.Dispose() }
$null = WindowOwner
Move-Item -LiteralPath $ownerTemp -Destination (Join-Path $root 'owner.json') -Force -ErrorAction Stop
$exe = Join-Path $root 'win-unpacked\Pi Bot.exe'
$env:PIBOT_DATA_DIR = Join-Path $root 'data'
$started = [DateTime]::UtcNow
$deadline = $started.AddSeconds(150)
Start-Process -FilePath $exe
$published = $false
while ([DateTime]::UtcNow -lt $deadline) {
  $null = WindowOwner
  if (-not $published) {
    foreach ($candidate in @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -eq $exe -and $_.CreationDate.ToUniversalTime() -ge $started })) {
      $window = Get-Process -Id $candidate.ProcessId -ErrorAction Stop
      try {
        $window.Refresh()
        if ($window.SessionId -ne $session -or $window.MainWindowHandle -eq 0) { continue }
        $row = @{schema=1;runId=$runId;artifactHash=$expectedHash;observedAt=[DateTime]::UtcNow.ToString('O');observerPid=$PID;observerCreated=$self.CreationDate.ToUniversalTime().ToString('O');observerPath=$self.ExecutablePath;observerSessionId=$session;userInteractive=$true;pid=$candidate.ProcessId;created=$candidate.CreationDate.ToUniversalTime().ToString('O');path=$candidate.ExecutablePath;sessionId=$window.SessionId;mainWindowHandle=$window.MainWindowHandle.ToInt64()}
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($row | ConvertTo-Json -Compress))
        if ($bytes.Length -gt 4096) { throw 'receipt_limit' }
        $null = WindowOwner
        $temporary = Join-Path $root 'interactive-window.tmp'
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
        $null = WindowOwner
        Move-Item -LiteralPath $temporary -Destination (Join-Path $root 'interactive-window.json') -ErrorAction Stop
        $published = $true
        break
      } finally { $window.Dispose() }
    }
  }
  # Stay owned until the SSH monitor consumes the receipt or stops this exact task/native PID.
  Start-Sleep -Milliseconds 250
}
`}`;
}

const windowReceiptReader = String.raw`
function ReadWindowReceipt {
  try {
    AssertOwned
    $file = Get-Item -LiteralPath (Join-Path $root 'interactive-window.json') -Force -ErrorAction Stop
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -le 0 -or $file.Length -gt 4096 -or $file.LastWriteTimeUtc -lt $started) { return $false }
    $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      if ($stream.Length -le 0 -or $stream.Length -gt 4096) { return $false }
      $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false, $true), $false)
      try { $receipt = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
    $keys = @('schema','runId','artifactHash','observedAt','observerPid','observerCreated','observerPath','observerSessionId','userInteractive','pid','created','path','sessionId','mainWindowHandle')
    if (@($receipt.PSObject.Properties).Count -ne $keys.Count -or @($receipt.PSObject.Properties | Where-Object { $_.Name -cnotin $keys }).Count) { return $false }
    if ($receipt.schema -ne 1 -or $receipt.runId -cne $runId -or $receipt.artifactHash -cne $expectedHash -or $receipt.userInteractive -isnot [bool] -or -not $receipt.userInteractive) { return $false }
    $appPid = 0; $observerPid = 0; $sessionId = 0; $handle = [long]0
    if (-not [int]::TryParse([string]$receipt.pid, [ref]$appPid) -or $appPid -le 0 -or -not [int]::TryParse([string]$receipt.observerPid, [ref]$observerPid) -or $observerPid -le 0 -or -not [int]::TryParse([string]$receipt.sessionId, [ref]$sessionId) -or $sessionId -le 0 -or $receipt.observerSessionId -ne $sessionId -or -not [long]::TryParse([string]$receipt.mainWindowHandle, [ref]$handle) -or $handle -eq 0) { return $false }
    $observed = [DateTimeOffset]::MinValue; $created = [DateTimeOffset]::MinValue; $observerCreated = [DateTimeOffset]::MinValue
    $culture = [Globalization.CultureInfo]::InvariantCulture
    $style = [Globalization.DateTimeStyles]::None
    if (-not [DateTimeOffset]::TryParseExact([string]$receipt.observedAt, 'O', $culture, $style, [ref]$observed) -or -not [DateTimeOffset]::TryParseExact([string]$receipt.created, 'O', $culture, $style, [ref]$created) -or -not [DateTimeOffset]::TryParseExact([string]$receipt.observerCreated, 'O', $culture, $style, [ref]$observerCreated)) { return $false }
    if ($observed.UtcDateTime -lt $started -or $observed.UtcDateTime -gt [DateTime]::UtcNow -or $observed.UtcDateTime -gt $started.AddSeconds(150) -or $created.UtcDateTime -lt $started -or $created -gt $observed -or $observerCreated.UtcDateTime -lt $started -or $observerCreated -gt $observed) { return $false }
    $owner = Get-Content -Raw -LiteralPath (Join-Path $root 'owner.json') | ConvertFrom-Json
    if ($owner.nativePid -ne $observerPid -or $owner.nativeCreated -cne $receipt.observerCreated -or -not [string]::Equals($owner.nativePath, $observerExe, [StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($receipt.observerPath, $observerExe, [StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($receipt.path, $exe, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $observer = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $observerPid) -ErrorAction Stop
    $app = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $appPid) -ErrorAction Stop
    if (-not $observer -or -not $app -or $observer.SessionId -ne $sessionId -or $app.SessionId -ne $sessionId -or $observer.CreationDate.ToUniversalTime().ToString('O') -cne $receipt.observerCreated -or $app.CreationDate.ToUniversalTime().ToString('O') -cne $receipt.created -or -not [string]::Equals($observer.ExecutablePath, $observerExe, [StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($app.ExecutablePath, $exe, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $action = [regex]::Match($observer.CommandLine, '(?i)-EncodedCommand\s+([A-Za-z0-9+/=]+)')
    if (-not $action.Success -or $action.Groups[1].Value -cne $encoded) { return $false }
    return $true
  } catch { return $false }
}
`;

export function idleScript(runId: string) {
  return `${header(runId)}${String.raw`
try {
  $directory = Join-Path $env:APPDATA 'Pi Bot\logs'
  $files = @(Get-ChildItem -LiteralPath $directory -Filter '*.log' -File -ErrorAction Stop)
  if ($files.Count -eq 0) { Emit 'idle' 'harness_failed' 'owner_idle_unknown'; exit 1 }
  $last = $files | Sort-Object LastWriteTimeUtc | Select-Object -Last 1
  if ($last.LastWriteTimeUtc -gt [DateTime]::UtcNow.AddMinutes(-10)) {
    Emit 'idle' 'skipped' 'owner_busy'
  } else { Emit 'idle' 'ok' 'owner_idle' }
} catch { Emit 'idle' 'harness_failed' 'owner_idle_unknown'; exit 1 }
`}`;
}
export function prepareScript(runId: string, artifactHash: string) {
  return `${header(runId)}${String.raw`
try {
  $root = Join-Path ([IO.Path]::GetFullPath($env:TEMP)) ('pibot-dev-' + $runId)
  if ($root -notmatch '^[A-Za-z]:\\' -or (Test-Path -LiteralPath $root)) {
    Emit 'prepare' 'harness_failed' 'remote_temp_unavailable'; exit 1
  }
  New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
  $created = $true
  $owner = @{runId=$runId;artifactHash=${ps(artifactHash)}} | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $root 'owner.json'), $owner, [Text.UTF8Encoding]::new($false))
  Emit 'prepare' 'ok' 'remote_prepared' ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($root)))
} catch {
  if ($created) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
  Emit 'prepare' 'harness_failed' 'remote_prepare_failed'; exit 1
}
`}`;
}
export function cleanupScript(runId: string, root: string | undefined, artifactHash: string) {
  return `${header(runId)}${ownership(root, artifactHash)}${windowTaskCleanup}${`
try { CleanupWindowTest } catch { Emit 'cleanup' 'harness_failed' 'remote_cleanup_unconfirmed'; exit 1 }
`}`;
}
/** The long deployment body travels as bytes; Windows SSH cannot launch its encoded command. */
export function uploadedDeployScript(
  runId: string,
  root: string,
  artifactHash: string,
  scriptHash: string,
) {
  return `${header(runId)}${ownership(root, artifactHash)}
try {
  AssertOwned
  $file = Join-Path $root 'deploy.ps1'
  $info = Get-Item -LiteralPath $file -Force -ErrorAction Stop
  if ($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $info.Length -gt 262144) { throw 'script' }
  $bytes = [IO.File]::ReadAllBytes($file)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $actual = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  if ($actual -ne ${ps(scriptHash)}) { throw 'script' }
  $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
  # Execute the same verified bytes, not a path that could change after hashing.
  & ([ScriptBlock]::Create($text))
} catch { Emit 'transport' 'harness_failed' 'remote_script_untrusted'; exit 1 }
`;
}
export function deployScript(
  runId: string,
  root: string,
  artifactHash: string,
  checks: readonly WindowsCheck[],
) {
  return `${header(runId)}${ownership(root, artifactHash)}${windowTaskCleanup}${windowReceiptReader}
$checks = @(${checks.map(ps).join(",")})
${String.raw`
function InvokeTar($arguments, $seconds) {
  $stdout = Join-Path $root 'tar-output.txt'; $stderr = Join-Path $root 'tar-errors.txt'
  $tar = (Get-Command tar.exe -ErrorAction Stop).Source
  $native = Start-Process -FilePath $tar -ArgumentList $arguments -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  try {
    # Retain the native handle before a short-lived tar exits; otherwise ExitCode can stay null.
    $null = $native.Handle
    $record = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $native.Id) -ErrorAction Stop
    if ($record) {
      $owner = Get-Content -Raw -LiteralPath (Join-Path $root 'owner.json') | ConvertFrom-Json
      $owner | Add-Member -NotePropertyName nativePid -NotePropertyValue $record.ProcessId -Force
      $owner | Add-Member -NotePropertyName nativeCreated -NotePropertyValue $record.CreationDate.ToUniversalTime().ToString("O") -Force
      $owner | Add-Member -NotePropertyName nativePath -NotePropertyValue $record.ExecutablePath -Force
      [IO.File]::WriteAllText((Join-Path $root 'owner.tmp'), ($owner | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
      Move-Item -LiteralPath (Join-Path $root 'owner.tmp') -Destination (Join-Path $root 'owner.json') -Force
    }
    $until = [DateTime]::UtcNow.AddSeconds($seconds)
    do {
      $native.Refresh()
      if ($native.HasExited) { break }
      foreach ($file in @($stdout,$stderr)) {
        if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -gt 8388608) { throw 'output_limit' }
      }
      if ([DateTime]::UtcNow -ge $until) { throw 'native_timeout' }
      Start-Sleep -Milliseconds 200
    } while ($true)
    $native.WaitForExit()
    if ($native.ExitCode -ne 0) { throw 'native_exit' }
    if ((Get-Item -LiteralPath $stdout).Length -gt 8388608) { throw 'output_limit' }
    @(Get-Content -LiteralPath $stdout -Encoding UTF8)
  } finally {
    try {
      $native.Refresh()
      if (-not $native.HasExited) {
        $native.Kill()
        if (-not $native.WaitForExit(5000)) { throw 'native_cleanup' }
      }
    } finally { $native.Dispose() }
  }
}
$exit = 0; $kind = 'harness_failed'; $reason = 'remote_deploy_failed'
try {
  AssertOwned
  $self = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID) -ErrorAction Stop
  $owner = @{runId=$runId;artifactHash=$expectedHash;workerPid=$PID;workerCreated=$self.CreationDate.ToUniversalTime().ToString("O")} | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $root 'owner.tmp'), $owner, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath (Join-Path $root 'owner.tmp') -Destination (Join-Path $root 'owner.json') -Force
  $archive = Join-Path $root 'application.tgz'
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    $reason = 'artifact_hash_mismatch'; throw 'hash'
  }
  $members = @(InvokeTar @('-tzf', ('"' + $archive + '"')) 60)
  if ($members.Count -gt 50000) { throw 'archive' }
  foreach ($member in $members) {
    if ($member -notmatch '^win-unpacked/' -or $member -match '(^|[/\\])\.\.([/\\]|$)|:|^[/\\]') { throw 'archive' }
  }
  InvokeTar @('-xzf', ('"' + $archive + '"'), '-C', ('"' + $root + '"')) 120 | Out-Null
  $links = @(Get-ChildItem -LiteralPath (Join-Path $root 'win-unpacked') -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop)
  if ($links.Count) { throw 'reparse' }
  $exe = Join-Path $root 'win-unpacked\Pi Bot.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'executable' }
  $data = Join-Path $root 'data'
  New-Item -ItemType Directory -Path $data -ErrorAction Stop | Out-Null
  $launch = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('`}${Buffer.from(windowObserver(runId, root, artifactHash), "utf16le").toString("base64")}${String.raw`'))
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launch))
  if ($encoded.Length -gt 24000) { throw 'observer_limit' }
  $observerExe = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
  $action = New-ScheduledTaskAction -Execute $observerExe -Argument ('-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $encoded)
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10)
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -ErrorAction Stop | Out-Null
  $started = [DateTime]::UtcNow
  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
  Emit 'deploy' 'ok' 'test_copy_started'
  $ready = @{}; $deadline = [DateTime]::UtcNow.AddSeconds(150)
  do {
    $errorLog = $false
    foreach ($folder in @('gui-logs','host-logs')) {
      $directory = Join-Path $data $folder
      if (-not (Test-Path -LiteralPath $directory)) { continue }
      $logs = @(Get-ChildItem -LiteralPath $directory -Filter '*.log' -File -ErrorAction Stop)
      if ($logs.Count -gt 30) { throw 'log_limit' }
      foreach ($log in $logs) {
        if ($log.Length -gt 4194304 -or ($log.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'log_limit' }
        foreach ($line in [IO.File]::ReadLines($log.FullName)) {
          try { $entry = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
          if ($entry.level -eq 'error') { $errorLog = $true }
          $event = $entry
          if ($entry.message -is [string]) {
            try { $event = $entry.message | ConvertFrom-Json -ErrorAction Stop } catch { $event = $null }
          }
          if ($folder -eq 'gui-logs' -and $event.event -eq 'gui_first_screen_ready') { $ready['first-screen'] = $true }
          if ($folder -eq 'host-logs' -and $event.event -eq 'owner_ready') { $ready['backend-ready'] = $true }
        }
      }
    }
    if ($errorLog) { $kind = 'failed'; $reason = 'application_error_log'; throw 'app_error' }
    if (ReadWindowReceipt) { $ready['app-window'] = $true }
    $missing = @($checks | Where-Object { -not $ready[$_] })
    if ($missing.Count -eq 0) { break }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  foreach ($check in $checks) {
    if ($ready[$check]) { Emit $check 'ok' 'check_passed' }
    else { Emit $check 'failed' 'check_not_ready'; $exit = 1 }
  }
} catch { Emit 'deploy' $kind $reason; $exit = 1 }
finally {
  try { CleanupWindowTest } catch { Emit 'cleanup' 'harness_failed' 'remote_cleanup_unconfirmed'; $exit = 1 }
}
exit $exit
`}`;
}
