# Watches the project folder and pushes to GitHub automatically.
# After files change, it waits until nothing has changed for $QuietSeconds (so a burst of
# saves becomes one commit), then runs scripts/auto-push.ps1 to commit and push.
# Started at Windows login by a shortcut in the Startup folder (see README), or by hand:
#   powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\watch-and-push.ps1
# Log: .git\auto-push.log
param([int]$QuietSeconds = 15, [int]$RetryMinutes = 5)

$root = Split-Path $PSScriptRoot -Parent
$pushScript = Join-Path $PSScriptRoot 'auto-push.ps1'
$log = Join-Path $root '.git\auto-push.log'

# Only one watcher per machine.
$single = New-Object System.Threading.Mutex($false, 'Global\RestaurantKdsWatcher')
if (-not $single.WaitOne(0)) { exit 0 }

function Write-Log($text) {
  $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $text
  Add-Content -Path $log -Value $line -Encoding UTF8
  if ((Get-Item $log).Length -gt 256KB) {  # keep the log small
    Get-Content $log -Tail 500 | Set-Content $log -Encoding UTF8
  }
}

# Changes here never need a commit, and .git changes are caused by the push itself.
$ignore = '^(\.git|data|node_modules)(\\|$)|~$|\.(swp|tmp)$'

function Invoke-Push {
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $pushScript 2>&1 | Out-String
  $msg = if ($out -match '"systemMessage": "([^"]*)"') { $Matches[1] } else { 'Nothing to push' }
  Write-Log $msg
  return ($msg -notmatch 'failed')
}

$watcher = New-Object System.IO.FileSystemWatcher $root
$watcher.IncludeSubdirectories = $true
$watcher.NotifyFilter = [IO.NotifyFilters]'FileName, DirectoryName, LastWrite, Size'

Write-Log "Watcher started for $root (quiet period ${QuietSeconds}s)"
$pending = $true            # push anything left over from before the watcher started
$lastChange = [datetime]::MinValue
$lastFailure = $null

while ($true) {
  $r = $watcher.WaitForChanged([IO.WatcherChangeTypes]::All, 2000)
  # Check the timer on every pass: ignored folders (e.g. the live database in data\) can
  # change constantly, so the wait may never time out during service.
  if (-not $r.TimedOut -and $r.Name -and $r.Name -notmatch $ignore) { $pending = $true; $lastChange = Get-Date }
  $now = Get-Date
  $retryDue = $lastFailure -and ($now - $lastFailure).TotalMinutes -ge $RetryMinutes
  if (($pending -and ($now - $lastChange).TotalSeconds -ge $QuietSeconds) -or $retryDue) {
    $pending = $false
    $lastFailure = if (Invoke-Push) { $null } else { $now }
  }
}
