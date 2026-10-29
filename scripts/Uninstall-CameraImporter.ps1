param([string]$Root='D:\CameraSync')
$ErrorActionPreference='Stop'
foreach($name in @('Immich Camera Importer','Immich Camera Dashboard')){
 $task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
 if($task){Stop-ScheduledTask -TaskName $task.TaskName -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $task.TaskName -Confirm:$false}
}
$expectedNode=Join-Path $Root 'runtime\node.exe'
$expectedServer=Join-Path $Root 'dashboard\server.mjs'
foreach($process in Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.ExecutablePath -eq $expectedNode -and $_.CommandLine -like ('*'+$expectedServer+'*')}){Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue}
Write-Output 'Automatic imports stopped. Local photos, configuration and encrypted credentials were preserved.'
Write-Output 'Revoke the Camera importer API key in Immich if this installation is no longer needed.'
