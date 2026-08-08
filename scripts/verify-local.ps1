$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $repoRoot 'outputs'
Set-Location -LiteralPath $repoRoot

function Wait-ForApi {
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  throw 'API did not become healthy within 20 seconds.'
}

function Get-AvailableSeat([int] $showtimeId, [string[]] $excluded) {
  $seatMap = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/showtimes/$showtimeId/seats" -TimeoutSec 5
  $seat = $seatMap.seats |
    Where-Object { $_.status -eq 'AVAILABLE' -and $_.seatLabel -notin $excluded } |
    Select-Object -First 1
  if ($null -eq $seat) { throw "No available seat remains on showtime $showtimeId." }
  return $seat.seatLabel
}

function Invoke-K6([string] $script, [int] $showtimeId, [string] $seatLabel, [string[]] $extraEnvironment) {
  $arguments = @(
    'run', '--rm', '--add-host=host.docker.internal:host-gateway',
    '--volume', "${repoRoot}\load-tests:/scripts:ro",
    '--volume', "${outputDir}:/outputs",
    '--workdir', '/outputs',
    'grafana/k6:2.1.0', 'run',
    '-e', 'BASE_URL=http://host.docker.internal:3000',
    '-e', "SHOWTIME_ID=$showtimeId",
    '-e', "SEAT_LABEL=$seatLabel"
  )
  foreach ($entry in $extraEnvironment) { $arguments += @('-e', $entry) }
  $arguments += "/scripts/$script"
  & docker @arguments
  if ($LASTEXITCODE -ne 0) { throw "k6 $script failed with exit code $LASTEXITCODE." }
}

Write-Host 'Container status:'
docker compose ps --all
if ($LASTEXITCODE -ne 0) { throw 'docker compose ps failed.' }

Wait-ForApi

docker compose up -d frontend
$maxAttempts = 5
$frontendOk = $false
for ($i = 1; $i -le $maxAttempts; $i++) {
  Start-Sleep -Seconds 2
  try {
    $frontend = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080' -TimeoutSec 5
    if ($frontend.StatusCode -eq 200) {
      Write-Host 'Frontend: HTTP 200'
      $frontendOk = $true
      break
    }
  } catch {
    Write-Host "Frontend check attempt $i/$maxAttempts failed, retrying..."
  }
}
if (-not $frontendOk) {
  Write-Host 'Frontend logs:'
  docker compose logs --tail 100 frontend
  throw 'Frontend did not respond with HTTP 200 after retries.'
}

$showtimes = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/showtimes' -TimeoutSec 5
$showtimeId = [int] $showtimes.showtimes[0].id
$scenarioASeat = Get-AvailableSeat -showtimeId $showtimeId -excluded @()
Write-Host "Running Scenario A on showtime $showtimeId seat $scenarioASeat"
Invoke-K6 -script 'scenario-a-contention.js' -showtimeId $showtimeId -seatLabel $scenarioASeat -extraEnvironment @()

$originalTtl = $env:HOLD_TTL_SECONDS
try {
  $env:HOLD_TTL_SECONDS = '5'
  docker compose up -d --force-recreate api
  if ($LASTEXITCODE -ne 0) { throw 'Could not recreate API with short hold TTL.' }
  Wait-ForApi
  $scenarioBSeat = Get-AvailableSeat -showtimeId $showtimeId -excluded @($scenarioASeat)
  Write-Host "Running Scenario B on showtime $showtimeId seat $scenarioBSeat"
  Invoke-K6 -script 'scenario-b-expiry.js' -showtimeId $showtimeId -seatLabel $scenarioBSeat -extraEnvironment @(
    'HOLD_TTL_SECONDS=5', 'EXPIRY_GRACE_SECONDS=2'
  )
} finally {
  if ($null -eq $originalTtl) {
    Remove-Item Env:HOLD_TTL_SECONDS -ErrorAction SilentlyContinue
  } else {
    $env:HOLD_TTL_SECONDS = $originalTtl
  }
  docker compose up -d --force-recreate api
  Wait-ForApi
  docker compose up -d frontend
}

Write-Host 'Running all real-gateway payment force modes...'
node scripts/verify-gateway-modes.mjs
if ($LASTEXITCODE -ne 0) { throw 'Gateway force-mode verification failed.' }

Write-Host 'Running deterministic OTP plus asynchronous payment flow...'
node scripts/verify-otp-flow.mjs
if ($LASTEXITCODE -ne 0) { throw 'OTP flow verification failed.' }

Write-Host 'Checking fault isolation with the gateway stopped...'
& "$PSScriptRoot\verify-fault-isolation.ps1"

Write-Host "Verification complete. Reports: $outputDir\scenario-a-summary.json and scenario-b-summary.json"
