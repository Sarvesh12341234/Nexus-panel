$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName 'NexusPanel' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host 'Removed Windows NexusPanel startup task.'
