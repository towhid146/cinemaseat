param(
  [string] $GitUserName = 'towhid146',
  [string] $GitUserEmail = 'towhid146@users.noreply.github.com'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

function Invoke-GitCommit([string] $message, [string[]] $paths) {
  & git add -- $paths
  if ($LASTEXITCODE -ne 0) { throw "Could not stage files for: $message" }
  & git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) { return }
  & git commit -m $message
  if ($LASTEXITCODE -ne 0) { throw "Could not create commit: $message" }
}

git config user.name $GitUserName
git config user.email $GitUserEmail

$remotes = @(git remote)
if ($remotes -notcontains 'origin') {
  git remote add origin 'https://github.com/towhid146/cinemaseat.git'
} elseif ((git remote get-url origin) -ne 'https://github.com/towhid146/cinemaseat.git') {
  throw 'The existing origin does not match https://github.com/towhid146/cinemaseat.git.'
}

$remoteMain = git ls-remote --heads origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not authenticate to the GitHub repository.' }
if ($remoteMain) { throw 'Remote main is not empty. Refusing to overwrite existing history.' }

Invoke-GitCommit 'chore: scaffold container stack database and CI' @(
  '.dockerignore', '.env.example', '.gitignore', '.github', 'docker-compose.yml',
  'package.json', 'package-lock.json', 'outputs/.gitkeep',
  'api/package.json', 'api/tsconfig.json', 'api/vitest.config.ts', 'api/Dockerfile',
  'api/src/config.ts', 'api/src/logger.ts', 'api/src/errors.ts', 'api/src/types.ts', 'api/src/db'
)

Invoke-GitCommit 'feat: implement concurrency-safe booking and gateway flows' @(
  'api/src/app.ts', 'api/src/server.ts', 'api/src/routes', 'api/src/services'
)

Invoke-GitCommit 'feat: add end-to-end React booking interface' @('frontend')

Invoke-GitCommit 'test: cover contention expiry webhooks and gateway modes' @(
  'api/tests', 'load-tests', 'scripts'
)

Invoke-GitCommit 'docs: document architecture operations and decisions' @('README.md', 'DECISIONS.md')

if (git status --porcelain) {
  git status --short
  throw 'Uncommitted files remain; review them before pushing.'
}

git push --set-upstream origin main
if ($LASTEXITCODE -ne 0) { throw 'GitHub push failed.' }

Write-Host 'Published CinemaSeat main to https://github.com/towhid146/cinemaseat'
