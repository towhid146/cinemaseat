$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

if ((git branch --show-current) -ne 'main') {
  throw 'Expected to publish from the main branch.'
}
if ((git remote get-url origin) -ne 'https://github.com/towhid146/cinemaseat.git') {
  throw 'The origin remote is not the CinemaSeat repository.'
}

$paths = @(
  '.gitattributes',
  'README.md',
  'scripts/aws-user-data.sh',
  'scripts/deploy-aws.ps1',
  'scripts/diagnose-aws.ps1',
  'scripts/recover-aws.ps1',
  'scripts/verify-deployed.ps1',
  'scripts/publish-final.ps1'
)
git add -- $paths
if ($LASTEXITCODE -ne 0) { throw 'Could not stage the verified deployment changes.' }

git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged changes failed whitespace validation.' }

git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Host 'Final deployment evidence is already committed.'
}
else {
  git commit -m 'deploy: record verified AWS release'
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the final deployment commit.' }
}

git push origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not push the final deployment commit.' }

if (git status --porcelain) {
  git status --short
  throw 'The repository still contains uncommitted tracked changes.'
}

Write-Host 'Final verified CinemaSeat release published.' -ForegroundColor Green
