function New-CameraTaskTriggers([string]$User){
 $logon=New-ScheduledTaskTrigger -AtLogOn -User $User
 $logon.Delay='PT30S'
 $recovery=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval ([TimeSpan]::FromMinutes(2))
 return @($logon,$recovery)
}
