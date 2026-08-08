$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

if ((git branch --show-current) -ne 'main') {
  throw 'Expected to publish from the main branch.'
}

git add -- frontend/src/App.tsx scripts/publish-frontend-fix.ps1
if ($LASTEXITCODE -ne 0) { throw 'Could not stage the frontend fix.' }

git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged frontend changes failed whitespace validation.' }

git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m 'fix: render frontend on non-HTTPS deployment'
  if ($LASTEXITCODE -ne 0) { throw 'Could not commit the frontend fix.' }
}

git push origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not push the frontend fix.' }

Write-Host 'Frontend fix published.' -ForegroundColor Green
