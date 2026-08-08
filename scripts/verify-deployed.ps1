$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $repoRoot 'outputs'
$deploymentFile = Join-Path $outputDirectory 'deployment.json'
Set-Location -LiteralPath $repoRoot

if (-not (Test-Path $deploymentFile)) {
  throw "Missing deployment evidence: $deploymentFile"
}
$deployment = Get-Content -Raw $deploymentFile | ConvertFrom-Json
$baseUrl = $deployment.frontendUrl.TrimEnd('/')

function Get-AvailableSeat([int]$ShowtimeId, [string[]]$Excluded) {
  $seatMap = Invoke-RestMethod -Uri "$baseUrl/api/showtimes/$ShowtimeId/seats" -TimeoutSec 15
  $seat = $seatMap.seats |
    Where-Object { $_.status -eq 'AVAILABLE' -and $_.seatLabel -notin $Excluded } |
    Select-Object -First 1
  if ($null -eq $seat) { throw "No available seat remains on showtime $ShowtimeId." }
  return $seat.seatLabel
}

function Invoke-K6([string]$Script, [int]$ShowtimeId, [string]$SeatLabel, [string[]]$ExtraEnvironment) {
  $arguments = @(
    'run', '--rm',
    '--volume', "${repoRoot}\load-tests:/scripts:ro",
    '--volume', "${outputDirectory}:/outputs",
    '--workdir', '/outputs',
    'grafana/k6:2.1.0', 'run',
    '-e', "BASE_URL=$baseUrl",
    '-e', "SHOWTIME_ID=$ShowtimeId",
    '-e', "SEAT_LABEL=$SeatLabel"
  )
  foreach ($entry in $ExtraEnvironment) { $arguments += @('-e', $entry) }
  $arguments += "/scripts/$Script"
  & docker @arguments
  if ($LASTEXITCODE -ne 0) { throw "k6 $Script failed with exit code $LASTEXITCODE." }
}

function Wait-ForPublicHealth {
  Write-Host 'Waiting for the CD deployment and load-balancer target to become healthy...'
  for ($attempt = 1; $attempt -le 120; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -Uri "$baseUrl/health" -UseBasicParsing -TimeoutSec 10
      if ($response.StatusCode -eq 200) { return $response }
    } catch {
      if ($attempt % 12 -eq 0) {
        Write-Host "Still waiting for public health ($($attempt * 5) seconds)..."
      }
      if ($attempt -eq 120) {
        throw "Public deployment did not become healthy within 10 minutes. Check GitHub Actions before retrying. Last error: $($_.Exception.Message)"
      }
    }
    Start-Sleep -Seconds 5
  }
}

$health = Wait-ForPublicHealth
if ($health.StatusCode -ne 200) { throw "Public health returned HTTP $($health.StatusCode)." }
Write-Host "Public health: HTTP 200 at $baseUrl" -ForegroundColor Green

$showtimes = Invoke-RestMethod -Uri "$baseUrl/api/showtimes" -TimeoutSec 15
$showtimeId = [int]$showtimes.showtimes[0].id

if (Test-Path "$outputDirectory\scenario-a-summary.json") {
  Copy-Item "$outputDirectory\scenario-a-summary.json" "$outputDirectory\local-scenario-a-summary.json" -Force
}
if (Test-Path "$outputDirectory\scenario-b-summary.json") {
  Copy-Item "$outputDirectory\scenario-b-summary.json" "$outputDirectory\local-scenario-b-summary.json" -Force
}

$scenarioASeat = Get-AvailableSeat -ShowtimeId $showtimeId -Excluded @()
Write-Host "Running deployed Scenario A on showtime $showtimeId seat $scenarioASeat..."
Invoke-K6 -Script 'scenario-a-contention.js' -ShowtimeId $showtimeId -SeatLabel $scenarioASeat -ExtraEnvironment @()
Move-Item "$outputDirectory\scenario-a-summary.json" "$outputDirectory\deployed-scenario-a-summary.json" -Force

$scenarioBSeat = Get-AvailableSeat -ShowtimeId $showtimeId -Excluded @($scenarioASeat)
Write-Host "Running deployed Scenario B on showtime $showtimeId seat $scenarioBSeat..."
Invoke-K6 -Script 'scenario-b-expiry.js' -ShowtimeId $showtimeId -SeatLabel $scenarioBSeat -ExtraEnvironment @(
  'HOLD_TTL_SECONDS=10', 'EXPIRY_GRACE_SECONDS=2'
)
Move-Item "$outputDirectory\scenario-b-summary.json" "$outputDirectory\deployed-scenario-b-summary.json" -Force

Write-Host 'Deployed Scenario A/B passed. Reports saved under outputs/.' -ForegroundColor Green
