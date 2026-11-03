param([switch]$ConfigureOnly, [switch]$Build, [string]$ProxyUrl = '')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$deployment = Join-Path $projectRoot 'deploy/team-gateway'
$envFile = Join-Path $deployment '.env'
function New-LocalSecret {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
if (!(Test-Path -LiteralPath $envFile)) {
    $version = Get-Content -LiteralPath (Join-Path $deployment 'versions.json') -Raw | ConvertFrom-Json
    $lines = @('GATEWAY_PORT=18310', ('NEW_API_IMAGE=' + $version.applicationImage), 'ADMIN_USERNAME=admin', ('ADMIN_PASSWORD=Aa1!' + (New-LocalSecret)), ('POSTGRES_PASSWORD=' + (New-LocalSecret)), ('REDIS_PASSWORD=' + (New-LocalSecret)), ('SESSION_SECRET=' + (New-LocalSecret)), ('MOCK_UPSTREAM_KEY=' + (New-LocalSecret)))
    [IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
}
if ($ConfigureOnly) { Write-Host 'Independent local configuration is ready.'; exit 0 }
$config = @{}
Get-Content -LiteralPath $envFile | ForEach-Object { if ($_ -match '^([^#=]+)=(.*)$') { $config[$Matches[1]] = $Matches[2] } }
$localImage = docker image ls --quiet $config['NEW_API_IMAGE']
if ($LASTEXITCODE -ne 0) { throw 'Cannot reach Docker Desktop. Start Docker Desktop and try again.' }
if ($Build -or !$localImage) { & (Join-Path $PSScriptRoot 'build-local.ps1') -ProxyUrl $ProxyUrl }
docker compose --env-file $envFile -f (Join-Path $deployment 'compose.yaml') up -d --wait --wait-timeout 240
if ($LASTEXITCODE -ne 0) { throw 'New API local startup failed.' }
$base = 'http://localhost:' + $config['GATEWAY_PORT']
$setup = Invoke-RestMethod -Uri ($base + '/api/setup')
if (!$setup.success) { throw 'Cannot read setup state.' }
if (!$setup.data.status) {
    if ($setup.data.root_init) { throw 'A root account already exists but setup is incomplete. Finish setup in the native UI; credentials were not changed.' }
    $body = @{ username=$config['ADMIN_USERNAME']; password=$config['ADMIN_PASSWORD']; confirmPassword=$config['ADMIN_PASSWORD']; SelfUseModeEnabled=$false; DemoSiteEnabled=$false } | ConvertTo-Json
    $result = Invoke-RestMethod -Method Post -Uri ($base + '/api/setup') -ContentType 'application/json' -Body $body
    if (!$result.success) { throw 'Native setup did not complete. Inspect the application logs.' }
}
Write-Host ('New API local console: ' + $base)
Write-Host ('Admin username: ' + $config['ADMIN_USERNAME'] + '; password is in deploy/team-gateway/.env (ADMIN_PASSWORD).')
