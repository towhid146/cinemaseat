$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

if ((git branch --show-current) -ne 'main') {
  throw 'Expected to publish from the main branch.'
}

git add -- frontend/src/App.tsx scripts/aws-user-data.sh README.md scripts/publish-hold-ttl-fix.ps1
if ($LASTEXITCODE -ne 0) { throw 'Could not stage the hold-expiry fix.' }

git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged changes failed whitespace validation.' }

git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m 'fix: restore practical production hold window'
  if ($LASTEXITCODE -ne 0) { throw 'Could not commit the hold-expiry fix.' }
}

git push origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not push the hold-expiry fix.' }

Write-Host 'Hold-expiry fix published.' -ForegroundColor Green
