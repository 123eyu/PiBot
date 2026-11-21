import { ps } from "./script-base.ts";

export function ownership(root: string | undefined, artifactHash: string) {
  return String.raw`
$rootKnown = ${root ? "$true" : "$false"}
$root = ${root ? ps(root) : "Join-Path ([IO.Path]::GetFullPath($env:TEMP)) ('pibot-dev-' + $runId)"}
$expectedHash = ${ps(artifactHash)}
function AssertOwned {
  if ([IO.Path]::GetFileName($root) -ne ('pibot-dev-' + $runId)) { throw 'identity' }
  $entry = Get-Item -LiteralPath $root -ErrorAction Stop
  if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'identity' }
  $owner = Get-Content -Raw -LiteralPath (Join-Path $root 'owner.json') | ConvertFrom-Json
  if ($owner.runId -ne $runId -or $owner.artifactHash -ne $expectedHash) { throw 'identity' }
}
function TestProcesses {
  $prefix = $root.TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
}
function StopExact($record) {
  try { $process = Get-Process -Id $record.ProcessId -ErrorAction Stop }
  catch {
    if (-not (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $record.ProcessId))) { return }
    throw 'process_unavailable'
  }
  try {
    $handle = $process.SafeHandle
    if ($process.HasExited) { return }
    if ($process.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fff') -ne $record.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fff') -or
        -not [string]::Equals($process.Path, $record.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'process_identity' }
    $process.Kill()
    if (-not $process.WaitForExit(5000)) { throw 'process_still_running' }
  } finally { $process.Dispose() }
}
function StopNative($owner) {
  if (-not $owner.nativePid) { return }
  $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $owner.nativePid) -ErrorAction Stop
  if ($current -and $current.CreationDate.ToUniversalTime().ToString("O") -eq $owner.nativeCreated -and $current.ExecutablePath -eq $owner.nativePath) {
    StopExact $current
    $until = [DateTime]::UtcNow.AddSeconds(5)
    do {
      $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $owner.nativePid) -ErrorAction Stop
      if (-not $current -or $current.CreationDate.ToUniversalTime().ToString("O") -ne $owner.nativeCreated) { return }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $until)
    throw 'native_still_running'
  }
}
function StopWorker {
  AssertOwned
  $owner = Get-Content -Raw -LiteralPath (Join-Path $root 'owner.json') | ConvertFrom-Json
  if ($owner.workerPid -eq $PID) { StopNative $owner; return }
  if (-not $owner.workerPid) { StopNative $owner; return }
  $worker = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $owner.workerPid) -ErrorAction Stop
  if ($worker) {
    if ($worker.CreationDate.ToUniversalTime().ToString("O") -ne $owner.workerCreated) { throw 'worker_identity' }
    $match = [regex]::Match($worker.CommandLine, '(?i)-EncodedCommand\s+([A-Za-z0-9+/=]+)')
    if (-not $match.Success) { throw 'worker_identity' }
    $decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($match.Groups[1].Value))
    if (-not $decoded.Contains("$" + "runId = '" + $runId + "'") -or -not $decoded.Contains("$" + "expectedHash = '" + $expectedHash + "'")) { throw 'worker_identity' }
    # Stop the producer before taking the descendant snapshot, closing the tar-spawn race.
    StopExact $worker
  }
  # Parent PID alone can refer to a reused number: every edge carries its parent's birth time.
  $workerCreated = [DateTime]::Parse([string]$owner.workerCreated, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
  $ids = @{}; $ids[[int]$owner.workerPid] = $workerCreated
  $known = @{}; $unconfirmed = $false
  $until = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    if ($all.Count -gt 10000) { throw 'process_limit' }
    foreach ($item in $all) {
      if ($item.ProcessId -eq $owner.workerPid -and $item.CreationDate.ToUniversalTime().ToString("O") -ne $owner.workerCreated) { throw 'worker_identity' }
      $previous = $known[[int]$item.ProcessId]
      if ($previous -and $previous.CreationDate -ne $item.CreationDate) { $ids.Remove([int]$item.ProcessId); $known.Remove([int]$item.ProcessId) }
    }
    for ($round = 0; $round -lt 64; $round++) {
      $added = $false
      foreach ($item in $all) {
        if (-not $ids.ContainsKey([int]$item.ProcessId) -and $ids.ContainsKey([int]$item.ParentProcessId)) {
          $created = $item.CreationDate.ToUniversalTime()
          $parentCreated = $ids[[int]$item.ParentProcessId]
          if ($created -lt $parentCreated) { $unconfirmed = $true; continue }
          $ids[[int]$item.ProcessId] = $created; $known[[int]$item.ProcessId] = $item; $added = $true
        }
      }
      if (-not $added) { break }
    }
    if ($added) { throw 'process_limit' }
    $alive = $false
    foreach ($item in $all) {
      $record = $known[[int]$item.ProcessId]
      if (($record -and $record.CreationDate -eq $item.CreationDate -and $record.ExecutablePath -eq $item.ExecutablePath) -or
          ($item.ProcessId -eq $owner.workerPid -and $item.CreationDate.ToUniversalTime().ToString("O") -eq $owner.workerCreated)) {
        $alive = $true; StopExact $item
      }
    }
    if (-not $alive) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $until)
  if ($alive) { throw 'worker_still_running' }
  $owner = Get-Content -Raw -LiteralPath (Join-Path $root 'owner.json') | ConvertFrom-Json
  StopNative $owner
  if ($unconfirmed) { throw 'descendant_identity' }
}
function Cleanup {
  $scheduled = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $taskName })
  if (-not (Test-Path -LiteralPath $root)) {
    if (-not $rootKnown -or $scheduled.Count -ne 0) { throw 'identity' }
    Emit 'cleanup' 'ok' 'already_clean'; return
  }
  AssertOwned
  StopWorker
  if ($scheduled.Count) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
  }
  foreach ($item in @(TestProcesses)) {
    $again = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $item.ProcessId) -ErrorAction Stop
    if ($again -and $again.CreationDate -eq $item.CreationDate -and $again.ExecutablePath -eq $item.ExecutablePath) {
      StopExact $again
    }
  }
  $until = [DateTime]::UtcNow.AddSeconds(15)
  while (@(TestProcesses).Count -gt 0 -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 250 }
  if (@(TestProcesses).Count -gt 0) { throw 'still_running' }
  AssertOwned
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $root) { throw 'cleanup' }
  Emit 'cleanup' 'ok' 'resources_removed'
}
`;
}
