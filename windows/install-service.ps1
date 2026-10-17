$ErrorActionPreference = 'Stop'
$task = 'NexusPanel'
$existingTask = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
if ($existingTask) {
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
}
throw 'NexusPanel no longer installs a SYSTEM startup task: Windows server processes lack per-server OS isolation. Server starts are disabled on Windows. Run the panel only under a restricted account for management-only use.'
