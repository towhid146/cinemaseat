param(
  [string]$Message = 'deploy: add AWS production provisioning'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

if ((git branch --show-current) -ne 'main') {
  throw 'Expected to publish from the main branch.'
}
if ((git remote get-url origin) -ne 'https://github.com/towhid146/cinemaseat.git') {
  throw 'The origin remote is not the CinemaSeat repository.'
}

git add -- frontend/nginx.conf scripts/aws-user-data.sh scripts/deploy-aws.ps1 scripts/publish-deployment-support.ps1
if ($LASTEXITCODE -ne 0) { throw 'Could not stage deployment support files.' }

git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Host 'Deployment support is already committed.'
}
else {
  git commit -m $Message
  if ($LASTEXITCODE -ne 0) { throw 'Could not commit deployment support.' }
}

git push origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not push deployment support to GitHub.' }

if (git status --porcelain) {
  git status --short
  throw 'The repository still contains uncommitted changes.'
}

Write-Host 'Deployment support published to main.' -ForegroundColor Green
