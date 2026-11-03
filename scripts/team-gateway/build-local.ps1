param([string]$ProxyUrl = '')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Set-Location -LiteralPath $projectRoot
$version = Get-Content -LiteralPath 'deploy/team-gateway/versions.json' -Raw | ConvertFrom-Json
$artifactRoot = Join-Path $projectRoot '.artifacts'
$runtimeContext = Join-Path $artifactRoot 'runtime-context'
New-Item -ItemType Directory -Path $runtimeContext -Force | Out-Null
$proxyArguments = @()
if ($ProxyUrl) { $proxyArguments = @('-e', ('HTTPS_PROXY=' + $ProxyUrl), '-e', ('HTTP_PROXY=' + $ProxyUrl)) }
docker run --rm @proxyArguments -e VITE_REACT_APP_VERSION=v1.0.0-rc.47 -v "${projectRoot}:/source" -v new-api-team-gateway-node-modules:/source/web/node_modules -v new-api-team-gateway-bun-cache:/root/.bun -w /source/web $version.bunImage bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency restore failed.' }
docker run --rm -e VITE_REACT_APP_VERSION=v1.0.0-rc.47 -v "${projectRoot}:/source" -v new-api-team-gateway-node-modules:/source/web/node_modules -w /source/web $version.bunImage bun run build:check
if ($LASTEXITCODE -ne 0) { throw 'Frontend typecheck or production build failed.' }
docker run --rm @proxyArguments -e CGO_ENABLED=0 -e GOWORK=off -e GOEXPERIMENT=greenteagc -e GODEBUG=http2client=0 -e GOMAXPROCS=4 -v "${projectRoot}:/source" -v new-api-team-gateway-gomod:/go/pkg/mod -v new-api-team-gateway-gocache:/root/.cache/go-build -w /source $version.goImage go build -ldflags '-s -w -X github.com/QuantumNous/new-api/common.Version=v1.0.0-rc.47-team.0' -o .artifacts/new-api .
if ($LASTEXITCODE -ne 0) { throw 'Backend source build failed.' }
Copy-Item -LiteralPath (Join-Path $artifactRoot 'new-api') -Destination (Join-Path $runtimeContext 'new-api') -Force
foreach ($name in @('LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.md')) { Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination (Join-Path $runtimeContext $name) -Force }
$buildProxy = @()
if ($ProxyUrl) { $buildProxy = @('--build-arg', ('HTTP_PROXY=' + $ProxyUrl), '--build-arg', ('HTTPS_PROXY=' + $ProxyUrl)) }
docker build @buildProxy --build-arg ('UPSTREAM_REVISION=' + $version.commit) -f deploy/team-gateway/runtime.Dockerfile -t new-api-team-gateway:local $runtimeContext
if ($LASTEXITCODE -ne 0) { throw 'Application image build failed.' }
Write-Host 'New API was built from local source with Docker. Run scripts/team-gateway/start-local.ps1.'
