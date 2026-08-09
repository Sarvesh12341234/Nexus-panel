$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Write-Host 'NexusPanel Windows installer'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 24 LTS or newer is required. Install Node.js and run this installer again.' }
$major = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($major -lt 24) { throw "Node.js 24+ required; detected $major" }
Write-Host "Using Node.js $(node --version)"
& npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
New-Item -ItemType Directory -Force -Path '.\data','.\servers','.\software','.\backups' | Out-Null
Write-Host 'Running NexusPanel first-run setup preparation...'
& node backend/cli.js setup-url
Write-Host ''
Write-Host 'Start NexusPanel with: npm start'
Write-Host 'Windows uses the portable process/path guard; Linux uses native Nexus-Mark isolation when supported.'
