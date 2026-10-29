param([string]$InstallRoot='D:\CameraSync',[string]$NodeExePath,[ValidateRange(1024,65535)][int]$Port=18474,[Security.SecureString]$ManagementApiKey,[switch]$NoStart)
$ErrorActionPreference='Stop'
$InstallRoot=[IO.Path]::GetFullPath($InstallRoot)
if(!(Test-Path -LiteralPath (Join-Path $InstallRoot 'config.json'))){throw 'Install the camera importer first'}
if(!$NodeExePath){$command=Get-Command node.exe -ErrorAction SilentlyContinue;if($command){$NodeExePath=$command.Source}}
if(!$NodeExePath -or !(Test-Path -LiteralPath $NodeExePath)){throw 'Specify a trusted installed Node.js 22+ executable with -NodeExePath'}
$version=& $NodeExePath --version
if($LASTEXITCODE -ne 0 -or [int](($version.TrimStart('v')) -split '\.')[0] -lt 22){throw 'Node.js 22 or newer is required'}
$metadataPath=Join-Path $InstallRoot 'private\api-key-metadata.json'
$metadata=Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if('asset.download' -notin $metadata.permissions){
 if(!$ManagementApiKey){$ManagementApiKey=Read-Host 'Existing Immich management API key, to allow verification downloads of originals' -AsSecureString}
 $secret=[Net.NetworkCredential]::new('', $ManagementApiKey).Password
 try{
  $headers=@{'x-api-key'=$secret}
  $current=Invoke-RestMethod ('http://127.0.0.1:2283/api/api-keys/'+$metadata.id) -Headers $headers -TimeoutSec 15
  $permissions=@(@($current.permissions)+@('asset.download') | Select-Object -Unique)
  $body=@{permissions=$permissions} | ConvertTo-Json -Compress
  Invoke-RestMethod ('http://127.0.0.1:2283/api/api-keys/'+$metadata.id) -Method Put -Headers $headers -ContentType application/json -Body $body -TimeoutSec 15 | Out-Null
  $metadata.permissions=$permissions
  $metadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadataPath -Encoding UTF8
 }finally{$secret=$null;$headers=$null;$ManagementApiKey=$null}
}
$taskName='Immich Camera Dashboard'
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existing){
 if(@($existing.Actions | Where-Object {$_.Arguments -notlike ('*'+(Join-Path $InstallRoot 'Start-CameraDashboard.ps1')+'*')}).Count){throw 'An unrelated task already uses this task name'}
 Stop-ScheduledTask -TaskName $taskName
 for($i=0;$i -lt 60;$i++){if((Get-ScheduledTask -TaskName $taskName).State -ne 'Running'){break};Start-Sleep -Milliseconds 250}
 if((Get-ScheduledTask -TaskName $taskName).State -eq 'Running'){throw 'The previous dashboard did not stop'}
 Start-Sleep -Milliseconds 500
}
$runtime=Join-Path $InstallRoot 'runtime';$destination=Join-Path $InstallRoot 'dashboard'
New-Item -ItemType Directory -Path $runtime,$destination -Force | Out-Null
$runtimeNode=Join-Path $runtime 'node.exe'
if(!(Test-Path -LiteralPath $runtimeNode) -or (Get-FileHash -LiteralPath $NodeExePath).Hash -ne (Get-FileHash -LiteralPath $runtimeNode).Hash){Copy-Item -LiteralPath $NodeExePath -Destination $runtimeNode -Force}
$source=Join-Path (Split-Path $PSScriptRoot) 'dashboard'
foreach($file in Get-ChildItem -LiteralPath $source -Recurse -File){$relative=$file.FullName.Substring($source.Length+1);$target=Join-Path $destination $relative;New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null;Copy-Item -LiteralPath $file.FullName -Destination $target -Force}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Start-CameraDashboard.ps1') -Destination (Join-Path $InstallRoot 'Start-CameraDashboard.ps1') -Force
@{port=$Port;bind='127.0.0.1';nodeVersion=$version} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $InstallRoot 'dashboard-settings.json') -Encoding UTF8
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+(Join-Path $InstallRoot 'Start-CameraDashboard.ps1')+'" -Root "'+$InstallRoot+'"')
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval ([TimeSpan]::FromMinutes(1)) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Local camera dashboard with verified, explicitly confirmed camera-file removal.' -Force | Out-Null
if(!$NoStart){Start-ScheduledTask -TaskName $taskName}
[pscustomobject]@{Url=('http://127.0.0.1:'+$Port);Task=$taskName;Started=(!$NoStart);Scope='This PC only';Runtime=$version}
