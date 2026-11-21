/** Data literals only; scripts and check names are fixed by this tool, never model-generated. */
export const ps = (text: string) => `'${text.replaceAll("'", "''")}'`;
export function header(runId: string) {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$runId = ${ps(runId)}
$taskName = 'PiBotDevTest-' + $runId
function Emit($stage, $outcome, $reason, $root64 = $null) {
  $row = @{runId=$runId;stage=$stage;outcome=$outcome;reason=$reason}
  if ($root64) { $row.root64 = $root64 }
  Write-Output ('PIBOT_WIN_RECEIPT ' + ($row | ConvertTo-Json -Compress))
}
`;
}
