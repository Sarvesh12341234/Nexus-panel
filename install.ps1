$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Write-Host 'NexusPanel Windows installer'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js >=22.5.0 and <25.0.0 is required. Install a supported Node.js version and rerun this installer.' }
$nodeVersion = [version]((node -p "process.versions.node").Trim())
if ($nodeVersion -lt [version]'22.5.0' -or $nodeVersion -ge [version]'25.0.0') { throw "Node.js >=22.5.0 and <25.0.0 required; detected $nodeVersion" }
Write-Host "Using Node.js $(node --version)"
& npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
New-Item -ItemType Directory -Force -Path '.\data','.\servers','.\software','.\backups' | Out-Null
Write-Host 'Running NexusPanel first-run setup preparation...'
& node backend/cli.js setup-url
Write-Host ''
Write-Host 'Start NexusPanel with: npm start'
Write-Host 'Windows uses the portable process/path guard; Linux uses native Nexus-Mark isolation when supported.'
