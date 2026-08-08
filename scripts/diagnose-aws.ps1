$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$deploymentFile = Join-Path $repoRoot 'outputs\deployment.json'
$diagnosticsFile = Join-Path $repoRoot 'outputs\aws-diagnostics.txt'
$credentialsFile = New-TemporaryFile

function ConvertFrom-SecureValue([Security.SecureString]$SecureValue) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Invoke-Aws([string[]]$AwsArguments) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $result = & docker run --rm `
      --env-file $credentialsFile.FullName `
      amazon/aws-cli:latest @AwsArguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  $message = (($result | Out-String).Trim())
  if ($exitCode -ne 0) {
    throw "AWS CLI failed: aws $($AwsArguments -join ' ')`nAWS response: $message"
  }
  return $message
}

try {
  if (-not (Test-Path $deploymentFile)) {
    throw "Missing deployment state: $deploymentFile"
  }
  $deployment = Get-Content -Raw $deploymentFile | ConvertFrom-Json
  if (-not $deployment.instanceId -or -not $deployment.targetGroupArn) {
    throw 'Deployment state does not contain an instance and target group.'
  }

  $accessKeySecure = Read-Host 'AWS access key ID' -AsSecureString
  $secretKeySecure = Read-Host 'AWS secret access key' -AsSecureString
  $accessKey = ConvertFrom-SecureValue $accessKeySecure
  $secretKey = ConvertFrom-SecureValue $secretKeySecure
  @(
    "AWS_ACCESS_KEY_ID=$accessKey"
    "AWS_SECRET_ACCESS_KEY=$secretKey"
    "AWS_DEFAULT_REGION=$($deployment.region)"
  ) | Set-Content -LiteralPath $credentialsFile.FullName -Encoding ascii
  $accessKey = $null
  $secretKey = $null

  $sections = [System.Collections.Generic.List[string]]::new()
  $sections.Add('=== TARGET HEALTH ===')
  $sections.Add((Invoke-Aws @(
    'elbv2', 'describe-target-health', '--target-group-arn', $deployment.targetGroupArn,
    '--output', 'json'
  )))
  $sections.Add('')
  $sections.Add('=== INSTANCE ===')
  $sections.Add((Invoke-Aws @(
    'ec2', 'describe-instances', '--instance-ids', $deployment.instanceId,
    '--query', 'Reservations[0].Instances[0].{State:State.Name,Type:InstanceType,PublicIp:PublicIpAddress,LaunchTime:LaunchTime,RootDevice:RootDeviceName}',
    '--output', 'json'
  )))
  $sections.Add('')
  $sections.Add('=== INSTANCE STATUS ===')
  $sections.Add((Invoke-Aws @(
    'ec2', 'describe-instance-status', '--instance-ids', $deployment.instanceId,
    '--include-all-instances', '--output', 'json'
  )))
  $sections.Add('')
  $sections.Add('=== BOOTSTRAP CONSOLE OUTPUT ===')
  try {
    # T2 instances do not support the --latest option. The default console
    # output still contains the cloud-init/user-data bootstrap stream.
    $sections.Add((Invoke-Aws @(
      'ec2', 'get-console-output', '--instance-id', $deployment.instanceId,
      '--query', 'Output', '--output', 'text'
    )))
  }
  catch {
    $sections.Add("Console output unavailable: $($_.Exception.Message)")
  }

  $sections | Set-Content -LiteralPath $diagnosticsFile -Encoding utf8
  Write-Host "Diagnostics saved to: $diagnosticsFile" -ForegroundColor Green
  Get-Content -LiteralPath $diagnosticsFile
}
finally {
  Remove-Item -LiteralPath $credentialsFile.FullName -Force -ErrorAction SilentlyContinue
}
