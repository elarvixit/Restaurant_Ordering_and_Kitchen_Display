# Commits any uncommitted changes and pushes them to GitHub.
# Run by the Claude Code Stop hook (.claude/settings.json) at the end of every Claude turn,
# and safe to run by hand: powershell -File scripts/auto-push.ps1
$ErrorActionPreference = 'Continue'
$env:Path = "C:\Program Files\Git\cmd;" + $env:Path
Set-Location (Split-Path $PSScriptRoot -Parent)

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
$changes = git status --porcelain
if ($changes) {
  $files = ($changes | ForEach-Object { $_.Substring(3) }) -join ', '
  if ($files.Length -gt 120) { $files = $files.Substring(0, 117) + '...' }
  git add -A | Out-Null
  git commit -q -m "Auto-commit: $files" | Out-Null
}

# Push whenever local is ahead (also retries commits a previous push failed on).
git fetch -q origin $branch 2>$null | Out-Null
$ahead = git rev-list --count "origin/$branch..HEAD" 2>$null
if (-not $ahead) { $ahead = (git rev-list --count HEAD).Trim() }  # remote branch not created yet
if ([int]$ahead -gt 0) {
  $out = git push -q -u origin $branch 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Output "{`"systemMessage`": `"Auto-pushed $ahead commit(s) to GitHub ($branch)`"}"
  } else {
    $msg = (($out | ForEach-Object { "$_" }) -match '^(fatal|error|remote|!)' ) -join ' ' -replace '[\\"]', "'"
    Write-Output "{`"systemMessage`": `"Auto-push to GitHub failed: $msg`"}"
  }
}
exit 0
