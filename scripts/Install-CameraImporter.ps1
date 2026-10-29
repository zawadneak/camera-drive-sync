param(
 [string]$InstallRoot='D:\CameraSync',
 [string]$AlbumName='Camera',
 [string]$CameraName='Camera',
 [string]$CameraPnpId,
 [Security.SecureString]$ManagementApiKey,
 [string]$InitialManifest,
 [switch]$ListCameras,
 [switch]$NoStart
)
$ErrorActionPreference='Stop'
if($ListCameras){
 Get-CimInstance Win32_DiskDrive -Filter "PNPDeviceID LIKE 'USBSTOR%'" | Select-Object Model,PNPDeviceID,SerialNumber
 return
}
if(!$CameraPnpId -or !$CameraPnpId.StartsWith('USBSTOR\')){throw 'Specify the exact USB disk PNPDeviceID from -ListCameras'}
if($CameraName -match '[<>:"/\\|?*]' -or $CameraName -in @('.','..')){throw 'CameraName must be a valid single directory name'}
$InstallRoot=[IO.Path]::GetFullPath($InstallRoot)
$server='http://127.0.0.1:2283'
$taskName='Immich Camera Importer'
$private=Join-Path $InstallRoot 'private'
$keyPath=Join-Path $private 'api-key.dpapi'
$configPath=Join-Path $InstallRoot 'config.json'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User.Value
New-Item -ItemType Directory -Path $InstallRoot,$private,(Join-Path $InstallRoot 'Inbox') -Force | Out-Null
& icacls.exe $private /inheritance:r /grant:r "*$($sid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not restrict the private configuration directory'}
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existing -and @($existing.Actions | Where-Object {$_.Arguments -notlike ('*'+(Join-Path $InstallRoot 'Watch-CameraInbox.ps1')+'*')}).Count){throw 'A different task already uses this task name'}
if(!$ManagementApiKey){$ManagementApiKey=Read-Host 'Existing Immich API key authorized to create an album and a limited service key' -AsSecureString}
$adminSecret=[Net.NetworkCredential]::new('', $ManagementApiKey).Password
$headers=@{'x-api-key'=$adminSecret}
$createdKeyId=$null
try{
 $allAlbums=Invoke-RestMethod ($server+'/api/albums') -Headers $headers -TimeoutSec 20
 $album=$allAlbums | Where-Object albumName -eq $AlbumName | Select-Object -First 1
 if(!$album){$body=@{albumName=$AlbumName} | ConvertTo-Json -Compress;$album=Invoke-RestMethod ($server+'/api/albums') -Method Post -Headers $headers -ContentType application/json -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20}
 if(!(Test-Path -LiteralPath $keyPath)){
  $permissions=@('asset.upload','asset.read','asset.view','asset.share','album.read','albumAsset.create')
  $body=@{name=('Camera importer - '+$CameraName);permissions=$permissions} | ConvertTo-Json -Compress
  $response=Invoke-RestMethod ($server+'/api/api-keys') -Method Post -Headers $headers -ContentType application/json -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20
  $createdKeyId=$response.id
  if(!$response.secret){throw 'Server did not return a service-key secret'}
  $secure=ConvertTo-SecureString $response.secret -AsPlainText -Force
  $secure | ConvertFrom-SecureString | Set-Content -LiteralPath $keyPath -Encoding UTF8
  [ordered]@{id=$response.id;name=$response.name;permissions=$permissions;protection='Windows DPAPI, current user'} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $private 'api-key-metadata.json') -Encoding UTF8
  $response=$null
 }
 $example=Get-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot) 'config.example.json') -Raw | ConvertFrom-Json
 $example.inbox=Join-Path $InstallRoot 'Inbox'
 $example.albumName=$AlbumName
 $example.albumId=$album.id
 $example.source.name=$CameraName
 $example.source.diskPnpId=$CameraPnpId
 if(Test-Path -LiteralPath $configPath){
  $old=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  if($old.source.diskPnpId -ne $CameraPnpId){throw 'Existing installation targets a different camera; keep its configuration intact'}
  $example.dateOverrides=$old.dateOverrides
 }
 if($InitialManifest){
  $manifest=Get-Content -LiteralPath $InitialManifest -Raw | ConvertFrom-Json
  $map=@{}
  if($example.dateOverrides){foreach($p in $example.dateOverrides.PSObject.Properties){$map[$p.Name]=$p.Value}}
  $sourceState=@{}
  foreach($file in $manifest){
   if(!$file.Sha1 -or !$file.CorrectedTimestamp){throw 'Initial manifest must include checksums and explicitly confirmed corrected timestamps'}
   $map[$file.Sha1]=([DateTimeOffset]$file.CorrectedTimestamp).ToString('o')
   if(Test-Path -LiteralPath $file.Destination){
    $ticks=([DateTimeOffset]$file.OriginalTimestamp).UtcDateTime.Ticks
    $sourceState[$CameraPnpId+'|'+$file.SourceRelative]=@{fingerprint="$($file.Bytes):$ticks";checksum=$file.Sha1;destination=$file.Destination}
   }
  }
  $example.dateOverrides=$map
  $sourceState | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $private 'source-state.json') -Encoding UTF8
 }
 if($existing){
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  for($attempt=0;$attempt -lt 40;$attempt++){
   if((Get-ScheduledTask -TaskName $taskName).State -ne 'Running'){break}
   Start-Sleep -Milliseconds 250
  }
  if((Get-ScheduledTask -TaskName $taskName).State -eq 'Running'){throw 'The previous watcher did not stop; preserve the running installation'}
 }
 Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Watch-CameraInbox.ps1') -Destination (Join-Path $InstallRoot 'Watch-CameraInbox.ps1') -Force
 $example | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding UTF8
 $action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+(Join-Path $InstallRoot 'Watch-CameraInbox.ps1')+'" -Root "'+$InstallRoot+'"')
 $trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
 $principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
 $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval ([TimeSpan]::FromMinutes(1)) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
 Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Copy the configured camera to the local inbox and import new media into Immich.' -Force | Out-Null
 if(!$NoStart){Start-ScheduledTask -TaskName $taskName}
 [pscustomobject]@{Installed=$InstallRoot;Task=$taskName;Album=$AlbumName;AlbumId=$album.id;StartsAt='Windows user sign-in';Started=(!$NoStart);Credentials='Dedicated limited key, encrypted with Windows DPAPI'}
}catch{
 if($createdKeyId -and !(Test-Path -LiteralPath $configPath)){
  try{
   Invoke-RestMethod ($server+'/api/api-keys/'+$createdKeyId) -Method Delete -Headers $headers -TimeoutSec 15 | Out-Null
   Remove-Item -LiteralPath $keyPath -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath (Join-Path $private 'api-key-metadata.json') -ErrorAction SilentlyContinue
  }catch{}
 }
 throw
}finally{$adminSecret=$null;$headers=$null;$ManagementApiKey=$null}
