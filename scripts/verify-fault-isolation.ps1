$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

function Invoke-Json([string] $uri, [string] $method = 'GET', [string] $body = '') {
  $parameters = @{ Uri = $uri; Method = $method; TimeoutSec = 10 }
  if ($body) {
    $parameters.ContentType = 'application/json'
    $parameters.Body = $body
  }
  return Invoke-RestMethod @parameters
}

Write-Host 'Stopping only the provided gateway container...'
docker compose stop gateway
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the gateway container.' }

try {
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  $health = Invoke-Json 'http://127.0.0.1:3000/health'
  $timer.Stop()
  if ($health.status -ne 'ok') { throw 'API health did not remain green.' }
  if ($timer.ElapsedMilliseconds -ge 1000) {
    throw "API health took $($timer.ElapsedMilliseconds) ms with the gateway down."
  }

  $movies = Invoke-Json 'http://127.0.0.1:3000/api/movies'
  $showtimes = Invoke-Json 'http://127.0.0.1:3000/api/showtimes'
  $showtimeId = [int] $showtimes.showtimes[0].id
  $seatMap = Invoke-Json "http://127.0.0.1:3000/api/showtimes/$showtimeId/seats"
  $seat = $seatMap.seats | Where-Object status -eq 'AVAILABLE' | Select-Object -First 1
  if ($movies.movies.Count -lt 1 -or $null -eq $seat) { throw 'Catalog or seat map failed with gateway down.' }

  $holdBody = @{ seatLabel = $seat.seatLabel; userId = "gateway-down-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" } | ConvertTo-Json
  $hold = Invoke-Json "http://127.0.0.1:3000/api/showtimes/$showtimeId/holds" 'POST' $holdBody
  if ($hold.status -ne 'HELD') { throw 'A seat could not be held while the gateway was down.' }

  Write-Host "PASS: /health=$($timer.ElapsedMilliseconds) ms; catalog, seat map, and hold remained available."
} finally {
  Write-Host 'Restarting the provided gateway container...'
  docker compose up -d gateway
  if ($LASTEXITCODE -ne 0) { throw 'Could not restart the gateway container.' }
}
