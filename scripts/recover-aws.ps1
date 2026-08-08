$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$deploymentFile = Join-Path $repoRoot 'outputs\deployment.json'
$userDataFile = Join-Path $PSScriptRoot 'aws-user-data.sh'
$credentialsFile = New-TemporaryFile
$keyDirectory = Join-Path ([IO.Path]::GetTempPath()) ("cinemaseat-recovery-" + [Guid]::NewGuid().ToString('N'))
$sshRuleAdded = $false
$clientCidr = $null
$deployment = $null

function ConvertFrom-SecureValue([Security.SecureString]$SecureValue) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Invoke-Aws([string[]]$AwsArguments, [switch]$AllowFailure) {
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
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "AWS CLI failed: aws $($AwsArguments -join ' ')`nAWS response: $message"
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = $message }
}

function Save-DeploymentState {
  $deployment.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  $deployment | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $deploymentFile -Encoding utf8
}

try {
  if (-not (Test-Path $deploymentFile)) {
    throw "Missing deployment state: $deploymentFile"
  }
  if (-not (Test-Path $userDataFile)) {
    throw "Missing recovery bootstrap: $userDataFile"
  }
  $deployment = Get-Content -Raw $deploymentFile | ConvertFrom-Json
  if (-not $deployment.instanceId -or -not $deployment.instanceSecurityGroupId) {
    throw 'Deployment state does not contain the existing instance and security group.'
  }
  if (-not (Get-Command ssh -ErrorAction SilentlyContinue) -or -not (Get-Command ssh-keygen -ErrorAction SilentlyContinue)) {
    throw 'Windows OpenSSH client is required (ssh.exe and ssh-keygen.exe).'
  }

  docker version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is not available.' }

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

  $instance = (Invoke-Aws @(
    'ec2', 'describe-instances', '--instance-ids', $deployment.instanceId,
    '--query', 'Reservations[0].Instances[0].{PublicIp:PublicIpAddress,Az:Placement.AvailabilityZone,State:State.Name}',
    '--output', 'json'
  )).Output | ConvertFrom-Json
  if ($instance.State -ne 'running' -or -not $instance.PublicIp) {
    throw "Existing instance is not reachable (state=$($instance.State), publicIp=$($instance.PublicIp))."
  }

  $clientIp = (Invoke-RestMethod -Uri 'https://checkip.amazonaws.com' -TimeoutSec 15).Trim()
  if ($clientIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
    throw "Could not determine a valid public IPv4 address: $clientIp"
  }
  $clientCidr = "$clientIp/32"

  Write-Host "Temporarily allowing SSH from $clientCidr..."
  $ingress = Invoke-Aws @(
    'ec2', 'authorize-security-group-ingress', '--group-id', $deployment.instanceSecurityGroupId,
    '--protocol', 'tcp', '--port', '22', '--cidr', $clientCidr
  ) -AllowFailure
  if ($ingress.ExitCode -eq 0) {
    $sshRuleAdded = $true
  }
  elseif ($ingress.Output -notmatch 'InvalidPermission.Duplicate') {
    throw "Could not authorize temporary SSH access: $($ingress.Output)"
  }

  New-Item -ItemType Directory -Path $keyDirectory -Force | Out-Null
  $keyPath = Join-Path $keyDirectory 'recovery-key'
  & ssh-keygen -q -t ed25519 -N '""' -f $keyPath
  if ($LASTEXITCODE -ne 0) { throw 'Could not generate the temporary recovery SSH key.' }
  $publicKey = (Get-Content -Raw "$keyPath.pub").Trim()

  Write-Host 'Sending a 60-second EC2 Instance Connect key...'
  $sendKey = Invoke-Aws @(
    'ec2-instance-connect', 'send-ssh-public-key',
    '--instance-id', $deployment.instanceId,
    '--availability-zone', $instance.Az,
    '--instance-os-user', 'ec2-user',
    '--ssh-public-key', $publicKey,
    '--output', 'json'
  )
  if (($sendKey.Output | ConvertFrom-Json).Success -ne $true) {
    throw 'EC2 Instance Connect did not accept the temporary key.'
  }

  Write-Host 'Repairing bootstrap and starting CinemaSeat on the existing VM...'
  $sshArguments = @(
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-i', $keyPath,
    "ec2-user@$($instance.PublicIp)",
    'sudo bash -s'
  )
  # PowerShell appends CRLF when piping a string to a native process. End with
  # a comment so the trailing carriage return is ignored by bash.
  $bootstrap = (Get-Content -Raw $userDataFile).TrimEnd("`r", "`n") + "`n# recovery-pipeline-terminator"
  $bootstrap | & ssh @sshArguments
  if ($LASTEXITCODE -ne 0) { throw 'Remote recovery bootstrap failed; its output is shown above.' }

  Write-Host 'Waiting for the public health endpoint...'
  $healthy = $false
  for ($attempt = 1; $attempt -le 120; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $deployment.healthUrl -UseBasicParsing -TimeoutSec 10
      if ($response.StatusCode -eq 200) {
        $healthy = $true
        break
      }
    }
    catch {
      if ($attempt % 6 -eq 0) {
        Write-Host "Still starting ($($attempt * 10) seconds elapsed)..."
      }
    }
    Start-Sleep -Seconds 10
  }
  if (-not $healthy) {
    throw 'CinemaSeat did not become healthy within 20 minutes.'
  }

  $deployment.status = 'HEALTHY'
  $deployment.error = $null
  $deployment | Add-Member -NotePropertyName recoveredAt `
    -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
  Save-DeploymentState
  Write-Host "CinemaSeat is healthy: $($deployment.frontendUrl)" -ForegroundColor Green
}
catch {
  if ($null -ne $deployment) {
    $deployment.status = 'RECOVERY_FAILED'
    $deployment.error = $_.Exception.Message
    Save-DeploymentState
  }
  Write-Error $_
  exit 1
}
finally {
  if ($sshRuleAdded -and $clientCidr -and $null -ne $deployment) {
    Write-Host 'Removing temporary SSH access...'
    Invoke-Aws @(
      'ec2', 'revoke-security-group-ingress', '--group-id', $deployment.instanceSecurityGroupId,
      '--protocol', 'tcp', '--port', '22', '--cidr', $clientCidr
    ) -AllowFailure | Out-Null
  }
  Remove-Item -LiteralPath $credentialsFile.FullName -Force -ErrorAction SilentlyContinue
  $resolvedKeyDirectory = [IO.Path]::GetFullPath($keyDirectory)
  $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedKeyDirectory.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $resolvedKeyDirectory) -like 'cinemaseat-recovery-*') {
    Remove-Item -LiteralPath $resolvedKeyDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
