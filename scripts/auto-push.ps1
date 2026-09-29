# Commits any uncommitted changes and pushes them to GitHub.
# Called by: the file watcher (scripts/watch-and-push.ps1), the Claude Code Stop hook
# (.claude/settings.json), and safe to run by hand: powershell -File scripts/auto-push.ps1
$ErrorActionPreference = 'Continue'
$env:Path = "C:\Program Files\Git\cmd;" + $env:Path
$env:AUTO_PUSH_RUNNING = '1'   # tells .git/hooks/post-commit not to start a second, racing push
Set-Location (Split-Path $PSScriptRoot -Parent)

# One run at a time: the watcher and the Claude hook can fire together.
$mutex = New-Object System.Threading.Mutex($false, 'Global\RestaurantKdsAutoPush')
if (-not $mutex.WaitOne([TimeSpan]::FromSeconds(60))) { exit 0 }
try {
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  $changes = git status --porcelain
  if ($changes) {
    $files = ($changes | ForEach-Object { $_.Substring(3).Trim('"') }) -join ', '
    if ($files.Length -gt 120) { $files = $files.Substring(0, 117) + '...' }
    git add -A 2>$null | Out-Null
    git commit -q -m "Auto-commit: $files" 2>$null | Out-Null
  }

  # Push whenever local is ahead (also retries commits an earlier push failed on).
  git fetch -q origin $branch 2>$null | Out-Null
  $ahead = git rev-list --count "origin/$branch..HEAD" 2>$null
  if (-not $ahead) { $ahead = (git rev-list --count HEAD).Trim() }  # remote branch not created yet
  if ([int]$ahead -gt 0) {
    $out = git push -q -u origin $branch 2>&1
    $remote = ((git ls-remote origin "refs/heads/$branch") -split '\s')[0]
    if ($LASTEXITCODE -eq 0 -or $remote -eq (git rev-parse HEAD).Trim()) {
      Write-Output "{`"systemMessage`": `"Auto-pushed $ahead commit(s) to GitHub ($branch)`"}"
    } else {
      $msg = (($out | ForEach-Object { "$_" }) -match '^(fatal|error|remote|!)') -join ' ' -replace '[\\"]', "'"
      Write-Output "{`"systemMessage`": `"Auto-push to GitHub failed: $msg`"}"
    }
  }
} finally {
  $mutex.ReleaseMutex()
}
exit 0
