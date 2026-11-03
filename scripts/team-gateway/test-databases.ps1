param(
    [ValidateSet('sqlite','mysql','postgres','all')][string]$Engine = 'all',
    [ValidateSet('fresh','upgrade','all')][string]$Scenario = 'all',
    [string]$Image = 'new-api-team-gateway:local',
    [int]$Port = 18330,
    [switch]$SkipModelTests,
    [switch]$Keep
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$arguments = @('-3.12', (Join-Path $projectRoot 'tests/team-gateway/team_smoke.py'), '--matrix', '--engine', $Engine, '--scenario', $Scenario, '--image', $Image, '--port', "$Port")
if ($SkipModelTests) { $arguments += '--skip-model-tests' }
if ($Keep) { $arguments += '--keep' }
& py @arguments
if ($LASTEXITCODE -ne 0) { throw 'Database acceptance failed; see .artifacts/database-acceptance for evidence.' }
