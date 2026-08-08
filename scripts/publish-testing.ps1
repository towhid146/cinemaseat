$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

if ((git branch --show-current) -ne 'main') {
  throw 'Expected to publish from the main branch.'
}
if ((git remote get-url origin) -ne 'https://github.com/towhid146/cinemaseat.git') {
  throw 'The origin remote is not the CinemaSeat repository.'
}

Write-Host 'Running typecheck, unit tests, and production builds...'
& npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed.' }
& npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

$paths = @(
  '.env.example',
  '.github/workflows/ci.yml',
  'README.md',
  'TESTING.md',
  'api/src/app.ts',
  'api/src/config.ts',
  'api/src/routes/webhook.ts',
  'api/src/services/bookings.ts',
  'api/src/services/gateway.ts',
  'api/src/types.ts',
  'api/tests/unit/config.test.ts',
  'api/tests/unit/gateway-otp.test.ts',
  'api/tests/unit/webhook-response.test.ts',
  'docker-compose.yml',
  'frontend/src/App.tsx',
  'frontend/src/api.ts',
  'package.json',
  'scripts/publish-testing.ps1',
  'scripts/recover-aws.ps1',
  'scripts/verify-fault-isolation.ps1',
  'scripts/verify-local.ps1',
  'scripts/verify-otp-flow.mjs'
)

git add -- $paths
if ($LASTEXITCODE -ne 0) { throw 'Could not stage the acceptance-test changes.' }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged changes failed whitespace validation.' }

git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m 'fix: complete gateway OTP and acceptance testing'
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the acceptance-test commit.' }
}

git push origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not push the acceptance-test commit.' }

if (git status --porcelain) {
  git status --short
  throw 'The repository still contains uncommitted changes.'
}

Write-Host 'Gateway OTP and testing changes are published.' -ForegroundColor Green
Write-Host 'Next, run .\scripts\recover-aws.ps1 to rebuild the existing AWS deployment.'
