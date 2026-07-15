# watch-daemon.ps1 - live, readable view of the running daemon's log.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\watch-daemon.ps1
# Follows the newest rotated pino log (daemon.N.log); falls back to
# daemon-stdout.log. ASCII-only on purpose (non-ASCII chars corrupt under
# PowerShell 5.1's default file encoding and break the parser).
$dir = "$env:LOCALAPPDATA\Astramem\logs"
$log = Get-ChildItem "$dir\daemon.*.log" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $log) { $log = Get-Item "$dir\daemon-stdout.log" -ErrorAction SilentlyContinue }
if (-not $log) {
  Write-Host "No daemon log found in $dir. Is the daemon running?" -ForegroundColor Yellow
  exit 1
}
Write-Host ("Following " + $log.FullName + "  (Ctrl+C to stop)") -ForegroundColor Cyan
Get-Content $log.FullName -Wait -Tail 40 | ForEach-Object {
  $line = $_
  try {
    $o = $line | ConvertFrom-Json
    $t = ''
    if ($o.time) { $t = [DateTimeOffset]::FromUnixTimeMilliseconds($o.time).LocalDateTime.ToString('HH:mm:ss') }
    $ctx = ''
    if ($o.path) { $ctx = $o.method + ' ' + $o.path + ' -> ' + $o.status }
    elseif ($o.job_kind) { $ctx = '[' + $o.job_kind + ' #' + $o.attempt + ']' }
    elseif ($o.provider) { $ctx = $o.provider + ' ' + $o.latency_ms + 'ms' }
    $color = 'Gray'
    if ($o.level -eq 50) { $color = 'Red' }
    elseif ($o.level -eq 40) { $color = 'Yellow' }
    Write-Host ($t + '  ' + $ctx + '  ' + $o.msg) -ForegroundColor $color
  } catch {
    Write-Host $line -ForegroundColor DarkGray
  }
}
