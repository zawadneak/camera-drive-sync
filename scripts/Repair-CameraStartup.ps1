param([string]$Root='D:\CameraSync')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'CameraTaskTriggers.ps1')
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
foreach($name in @('Immich Camera Importer','Immich Camera Dashboard')){
 $task=Get-ScheduledTask -TaskName $name
 if(@($task.Actions|Where-Object {$_.Arguments -notlike ('*'+$Root+'\*')}).Count){throw 'Refusing to change an unrelated task'}
 $task.Triggers=@(New-CameraTaskTriggers $identity.Name)
 $task.Settings.Enabled=$true
 # Ignore a recovery trigger while this task is already running.
 $task.Settings.MultipleInstances=2
 $null=Set-ScheduledTask -InputObject $task
 if((Get-ScheduledTask -TaskName $name).State -ne 'Running'){Start-ScheduledTask -TaskName $name}
}
