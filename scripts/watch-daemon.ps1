# watch-daemon.ps1 — live, readable view of the running daemon's log.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\watch-daemon.ps1
$log = "$env:LOCALAPPDATA\Astramem\logs\daemon-stdout.log"
if (-not (Test-Path $log)) { Write-Host "No log yet at $log — is the daemon running?" -ForegroundColor Yellow; exit 1 }
Write-Host "Following $log  (Ctrl+C to stop)" -ForegroundColor Cyan
Get-Content $log -Wait -Tail 25 | ForEach-Object {
  $line = $_
  try {
    $o = $line | ConvertFrom-Json
    $t = if ($o.time) { [DateTimeOffset]::FromUnixTimeMilliseconds($o.time).LocalDateTime.ToString('HH:mm:ss') } else { '' }
    $lvl = switch ($o.level) { 50 {'ERR '} 40 {'WARN'} default {'    '} }
    $ctx = @()
    if ($o.stage)  { $ctx += "[$($o.stage)]" }
    if ($o.path)   { $ctx += "$($o.method) $($o.path)->$($o.status)" }
    if ($o.provider) { $ctx += "$($o.provider) $($o.latency_ms)ms" }
    if ($o.job_kind) { $ctx += "job=$($o.job_kind)#$($o.attempt)" }
    $color = switch ($o.level) { 50 {'Red'} 40 {'Yellow'} default {'Gray'} }
    Write-Host ("{0} {1} {2} {3}" -f $t, $lvl, ($ctx -join ' '), $o.msg) -ForegroundColor $color
  } catch { Write-Host $line -ForegroundColor DarkGray }
}
