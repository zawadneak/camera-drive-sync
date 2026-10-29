$ErrorActionPreference='Stop'
$task=Get-ScheduledTask -TaskName 'Immich Camera Importer' -ErrorAction SilentlyContinue
if($task){Stop-ScheduledTask -TaskName $task.TaskName -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false}
Write-Output 'Automatic imports stopped. Local photos, configuration and encrypted credentials were preserved.'
Write-Output 'Revoke the Camera importer API key in Immich if this installation is no longer needed.'
