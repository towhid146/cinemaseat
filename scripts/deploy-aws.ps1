param(
  [string]$Region = 'ap-southeast-1',
  [string]$InstanceType = 't3.small'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $repoRoot 'outputs'
$deploymentFile = Join-Path $outputDirectory 'deployment.json'
$userDataFile = Join-Path $PSScriptRoot 'aws-user-data.sh'
$credentialsFile = New-TemporaryFile
$created = [ordered]@{}

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
  $volume = ($PSScriptRoot -replace '\\', '/') + ':/workspace/scripts:ro'
  $result = & docker run --rm `
    --env-file $credentialsFile.FullName `
    --volume $volume `
    amazon/aws-cli:latest @AwsArguments

  if ($LASTEXITCODE -ne 0) {
    throw "AWS CLI failed: aws $($AwsArguments -join ' ')"
  }

  return (($result | Out-String).Trim())
}

function Save-DeploymentState {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
  $created.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  $created | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $deploymentFile -Encoding utf8
}

try {
  if (-not (Test-Path $userDataFile)) {
    throw "Missing user-data template: $userDataFile"
  }

  docker version | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw 'Docker Desktop is not available.'
  }

  Write-Host 'CinemaSeat AWS deployment'
  Write-Host "Region: $Region | Instance: $InstanceType"
  Write-Host 'This creates billable EC2 and Application Load Balancer resources.' -ForegroundColor Yellow

  $accessKeySecure = Read-Host 'AWS access key ID' -AsSecureString
  $secretKeySecure = Read-Host 'AWS secret access key' -AsSecureString
  $accessKey = ConvertFrom-SecureValue $accessKeySecure
  $secretKey = ConvertFrom-SecureValue $secretKeySecure
  @(
    "AWS_ACCESS_KEY_ID=$accessKey"
    "AWS_SECRET_ACCESS_KEY=$secretKey"
    "AWS_DEFAULT_REGION=$Region"
  ) | Set-Content -LiteralPath $credentialsFile.FullName -Encoding ascii
  $accessKey = $null
  $secretKey = $null

  Write-Host 'Validating AWS identity...'
  $identity = Invoke-Aws @('sts', 'get-caller-identity', '--output', 'json') | ConvertFrom-Json
  $created.accountId = $identity.Account
  $created.region = $Region
  $created.instanceType = $InstanceType
  $created.startedAt = (Get-Date).ToUniversalTime().ToString('o')

  $suffix = (Get-Date -Format 'MMddHHmm')
  $vpcId = Invoke-Aws @(
    'ec2', 'describe-vpcs',
    '--filters', 'Name=is-default,Values=true',
    '--query', 'Vpcs[0].VpcId', '--output', 'text'
  )
  if (-not $vpcId -or $vpcId -eq 'None') {
    throw "No default VPC exists in $Region."
  }
  $created.vpcId = $vpcId

  $subnets = Invoke-Aws @(
    'ec2', 'describe-subnets',
    '--filters', "Name=vpc-id,Values=$vpcId", 'Name=map-public-ip-on-launch,Values=true',
    '--query', 'Subnets[].{id:SubnetId,az:AvailabilityZone}', '--output', 'json'
  ) | ConvertFrom-Json
  $selectedSubnets = @($subnets | Sort-Object az | Group-Object az | ForEach-Object { $_.Group[0] } | Select-Object -First 2)
  if ($selectedSubnets.Count -lt 2) {
    throw 'An internet-facing load balancer requires public subnets in at least two availability zones.'
  }
  $created.subnetIds = @($selectedSubnets.id)

  $amiId = Invoke-Aws @(
    'ssm', 'get-parameter',
    '--name', '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
    '--query', 'Parameter.Value', '--output', 'text'
  )
  $created.amiId = $amiId

  Write-Host 'Creating security groups...'
  $instanceSecurityGroupId = Invoke-Aws @(
    'ec2', 'create-security-group', '--group-name', "cinemaseat-instance-$suffix",
    '--description', 'CinemaSeat application instance', '--vpc-id', $vpcId,
    '--query', 'GroupId', '--output', 'text'
  )
  $created.instanceSecurityGroupId = $instanceSecurityGroupId
  Save-DeploymentState

  $loadBalancerSecurityGroupId = Invoke-Aws @(
    'ec2', 'create-security-group', '--group-name', "cinemaseat-alb-$suffix",
    '--description', 'CinemaSeat public load balancer', '--vpc-id', $vpcId,
    '--query', 'GroupId', '--output', 'text'
  )
  $created.loadBalancerSecurityGroupId = $loadBalancerSecurityGroupId
  Save-DeploymentState

  Invoke-Aws @(
    'ec2', 'authorize-security-group-ingress', '--group-id', $loadBalancerSecurityGroupId,
    '--protocol', 'tcp', '--port', '80', '--cidr', '0.0.0.0/0'
  ) | Out-Null
  Invoke-Aws @(
    'ec2', 'authorize-security-group-ingress', '--group-id', $instanceSecurityGroupId,
    '--protocol', 'tcp', '--port', '80', '--source-group', $loadBalancerSecurityGroupId
  ) | Out-Null

  Write-Host 'Launching EC2 instance...'
  $instanceId = Invoke-Aws @(
    'ec2', 'run-instances', '--image-id', $amiId, '--instance-type', $InstanceType,
    '--subnet-id', $selectedSubnets[0].id, '--security-group-ids', $instanceSecurityGroupId,
    '--associate-public-ip-address', '--user-data', 'file:///workspace/scripts/aws-user-data.sh',
    '--tag-specifications', "ResourceType=instance,Tags=[{Key=Name,Value=CinemaSeat-$suffix}]",
    '--query', 'Instances[0].InstanceId', '--output', 'text'
  )
  $created.instanceId = $instanceId
  Save-DeploymentState
  Invoke-Aws @('ec2', 'wait', 'instance-running', '--instance-ids', $instanceId) | Out-Null

  Write-Host 'Creating target group and load balancer...'
  $targetGroupArn = Invoke-Aws @(
    'elbv2', 'create-target-group', '--name', "cinemaseat-tg-$suffix",
    '--protocol', 'HTTP', '--port', '80', '--vpc-id', $vpcId,
    '--target-type', 'instance', '--health-check-path', '/health',
    '--health-check-interval-seconds', '10', '--healthy-threshold-count', '2',
    '--query', 'TargetGroups[0].TargetGroupArn', '--output', 'text'
  )
  $created.targetGroupArn = $targetGroupArn
  Save-DeploymentState
  Invoke-Aws @(
    'elbv2', 'register-targets', '--target-group-arn', $targetGroupArn,
    '--targets', "Id=$instanceId,Port=80"
  ) | Out-Null

  $loadBalancer = Invoke-Aws @(
    'elbv2', 'create-load-balancer', '--name', "cinemaseat-$suffix",
    '--type', 'application', '--scheme', 'internet-facing', '--ip-address-type', 'ipv4',
    '--security-groups', $loadBalancerSecurityGroupId,
    '--subnets', $selectedSubnets[0].id, $selectedSubnets[1].id,
    '--query', 'LoadBalancers[0].{arn:LoadBalancerArn,dns:DNSName}', '--output', 'json'
  ) | ConvertFrom-Json
  $created.loadBalancerArn = $loadBalancer.arn
  $created.loadBalancerDns = $loadBalancer.dns
  $created.frontendUrl = "http://$($loadBalancer.dns)"
  $created.healthUrl = "http://$($loadBalancer.dns)/health"
  Save-DeploymentState

  Invoke-Aws @('elbv2', 'wait', 'load-balancer-available', '--load-balancer-arns', $loadBalancer.arn) | Out-Null
  $listenerArn = Invoke-Aws @(
    'elbv2', 'create-listener', '--load-balancer-arn', $loadBalancer.arn,
    '--protocol', 'HTTP', '--port', '80',
    '--default-actions', "Type=forward,TargetGroupArn=$targetGroupArn",
    '--query', 'Listeners[0].ListenerArn', '--output', 'text'
  )
  $created.listenerArn = $listenerArn
  Save-DeploymentState

  Write-Host 'Waiting for the application target to become healthy (the first image build can take several minutes)...'
  Invoke-Aws @('elbv2', 'wait', 'target-in-service', '--target-group-arn', $targetGroupArn, '--targets', "Id=$instanceId,Port=80") | Out-Null

  $response = Invoke-WebRequest -Uri $created.healthUrl -UseBasicParsing -TimeoutSec 20
  if ($response.StatusCode -ne 200) {
    throw "Public health check returned HTTP $($response.StatusCode)."
  }
  $created.status = 'HEALTHY'
  $created.completedAt = (Get-Date).ToUniversalTime().ToString('o')
  Save-DeploymentState

  Write-Host "Deployment is healthy: $($created.frontendUrl)" -ForegroundColor Green
  Write-Host "Evidence saved to: $deploymentFile"
}
catch {
  $created.status = 'FAILED'
  $created.error = $_.Exception.Message
  Save-DeploymentState
  Write-Error $_
  exit 1
}
finally {
  Remove-Item -LiteralPath $credentialsFile.FullName -Force -ErrorAction SilentlyContinue
}
