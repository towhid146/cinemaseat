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
  '.env.example',
  '.github/workflows/cd.yml',
  '.github/workflows/ci.yml',
  'README.md',
  'TESTING.md',
  'DECISIONS.md',
  'api/package.json',
  'api/src/app.ts',
  'api/src/config.ts',
  'api/src/server.ts',
  'api/src/services/bookings.ts',
  'api/src/services/redis.ts',
  'api/tests/integration/booking-concurrency.test.ts',
  'api/tests/integration/webhook-deduplication.test.ts',
  'api/tests/unit/config.test.ts',
  'api/tests/unit/redis.test.ts',
  'docker-compose.yml',
  'package-lock.json',
  'scripts/publish-cd.ps1',
  'scripts/verify-fault-isolation.ps1'
)

git add -- $paths
if ($LASTEXITCODE -ne 0) { throw 'Could not stage the verified release.' }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged CD changes failed whitespace validation.' }

git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -m 'feat: add Redis acceleration and production CD'
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the release commit.' }
}

git push origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not push the release commit.' }

if (git status --porcelain) {
  git status --short
  throw 'The repository still contains uncommitted changes.'
}

Write-Host 'CD workflow published. GitHub Actions should now start CI and CD.' -ForegroundColor Green
Write-Host 'Open https://github.com/towhid146/cinemaseat/actions to watch the deployment.'
