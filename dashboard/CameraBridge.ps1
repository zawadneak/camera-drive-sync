param([Parameter(Mandatory=$true)][ValidateSet('Snapshot','Secret','Delete','Wake')][string]$Action,[string]$Root='D:\CameraSync')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$config=Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
function Read-Json([string]$Path){if(Test-Path -LiteralPath $Path){return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)};return $null}
function Property-Value($Object,[string]$Name){if($Object){$p=$Object.PSObject.Properties[$Name];if($p){return $p.Value}};return $null}
function Camera-Volume {
 $disk=Get-CimInstance Win32_DiskDrive -Filter "PNPDeviceID LIKE 'USBSTOR%'" | Where-Object PNPDeviceID -eq $config.source.diskPnpId
 if(!$disk){return $null}
 foreach($partition in Get-CimAssociatedInstance -InputObject $disk -Association Win32_DiskDriveToDiskPartition){
  foreach($drive in Get-CimAssociatedInstance -InputObject $partition -Association Win32_LogicalDiskToPartition){
   if(Test-Path -LiteralPath (Join-Path ($drive.DeviceID+'\') 'DCIM')){
    return @{root=($drive.DeviceID+'\');serial=$drive.VolumeSerialNumber;identity=($disk.PNPDeviceID+'|'+$drive.VolumeSerialNumber)}
   }
  }
 }
 return $null
}
function File-Id([string]$Value){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Check-InboxPath([string]$Path){
 $base=[IO.Path]::GetFullPath($config.inbox).TrimEnd('\')+'\'
 $resolved=[IO.Path]::GetFullPath($Path)
 if(!$resolved.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'Archive path is outside the configured inbox'}
 return $resolved
}
function Camera-Path($Volume,[string]$Relative){
 if(!$Relative -or $Relative -match '(^[\\/])|:|(^|[\\/])\.\.([\\/]|$)'){throw 'Invalid camera-relative path'}
 $path=[IO.Path]::GetFullPath((Join-Path $Volume.root $Relative))
 $allowed=$false
 foreach($mediaRoot in $config.source.mediaRoots){$prefix=[IO.Path]::GetFullPath((Join-Path $Volume.root $mediaRoot)).TrimEnd('\')+'\';if($path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$allowed=$true}}
 if(!$allowed -or [IO.Path]::GetExtension($path).ToLowerInvariant() -notin $config.extensions){throw 'File is outside the camera media folders'}
 $current=$path
 while($current -and $current.Length -gt $Volume.root.Length){
  if(([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse points cannot be deleted through this dashboard'}
  $current=[IO.Path]::GetDirectoryName($current)
 }
 return $path
}
try{
 if($Action -eq 'Secret'){
  $secure=ConvertTo-SecureString ((Get-Content -LiteralPath (Join-Path $Root 'private\api-key.dpapi') -Raw).Trim())
  $result=@{secret=[Net.NetworkCredential]::new('', $secure).Password}
 }elseif($Action -eq 'Wake'){
  try{$event=[Threading.EventWaitHandle]::OpenExisting('Local\ImmichCameraSyncWake');try{$null=$event.Set()}finally{$event.Dispose()}}catch [Threading.WaitHandleCannotBeOpenedException]{Start-ScheduledTask -TaskName 'Immich Camera Importer'}
  $result=@{requested=$true}
 }else{
  $source=Read-Json (Join-Path $Root 'private\source-state.json')
  $state=Read-Json (Join-Path $Root 'private\state.json')
  $volume=Camera-Volume
  if($Action -eq 'Snapshot'){
   $rows=[Collections.Generic.List[object]]::new();$seen=[Collections.Generic.HashSet[string]]::new()
   if($volume){
    foreach($relativeRoot in $config.source.mediaRoots){
     $directory=Join-Path $volume.root $relativeRoot
     if(!(Test-Path -LiteralPath $directory)){continue}
     foreach($file in Get-ChildItem -LiteralPath $directory -File -Recurse | Where-Object {$_.Extension.ToLowerInvariant() -in $config.extensions}){
      $relative=$file.FullName.Substring($volume.root.Length)
      $record=Property-Value $source ($config.source.diskPnpId+'|'+$relative)
      $backup=if($record){Property-Value $state $record.destination}else{$null}
      $fingerprint="$($file.Length):$($file.LastWriteTimeUtc.Ticks)"
      $imported=($record -and $backup -and $record.fingerprint -eq $fingerprint -and (Test-Path -LiteralPath $record.destination) -and $record.checksum -eq $backup.checksum)
      $date=$file.LastWriteTime.ToString('o')
      $override=if($record){Property-Value $config.dateOverrides $record.checksum}else{$null}
      if($override){$date=([DateTimeOffset]$override).ToString('o')}
      $rows.Add(@{id=(File-Id ($volume.identity+'|'+$relative));name=$file.Name;relativePath=$relative;cameraPath=$file.FullName;bytes=$file.Length;fingerprint=$fingerprint;capturedAt=$date;type=$(if($file.Extension -match '^\.(mp4|mov|mts|m2ts)$'){'video'}else{'photo'});onCamera=$true;imported=[bool]$imported;sha1=$(if($record){$record.checksum}else{$null});archivePath=$(if($record){$record.destination}else{$null});assetId=$(if($imported){$backup.assetId}else{$null})})
      if($record){$null=$seen.Add($record.destination)}
     }
    }
   }
   foreach($entry in @($state.PSObject.Properties)){
    if(!$entry -or $seen.Contains($entry.Name)){continue}
    $file=Get-Item -LiteralPath $entry.Name -ErrorAction SilentlyContinue
    if(!$file){continue}
    $override=Property-Value $config.dateOverrides $entry.Value.checksum
    $date=if($override){([DateTimeOffset]$override).ToString('o')}else{$file.LastWriteTime.ToString('o')}
    $rows.Add(@{id=(File-Id ('archive|'+$entry.Name));name=$file.Name;relativePath=$null;bytes=$file.Length;fingerprint=$null;capturedAt=$date;type=$(if($file.Extension -match '^\.(mp4|mov|mts|m2ts)$'){'video'}else{'photo'});onCamera=$false;imported=$true;sha1=$entry.Value.checksum;archivePath=$entry.Name;assetId=$entry.Value.assetId})
   }
   $activity=@(Get-Content -LiteralPath (Join-Path $Root 'events.jsonl') -Tail 18 -ErrorAction SilentlyContinue | ForEach-Object {try{$_ | ConvertFrom-Json}catch{}})
   $result=@{camera=@{connected=[bool]$volume;name=$config.source.name;identity=$(if($volume){$volume.identity}else{$null});drive=$(if($volume){$volume.root}else{$null})};importer=(Read-Json (Join-Path $Root 'status.json'));album=@{id=$config.albumId;name=$config.albumName};files=@($rows);activity=$activity}
  }else{
   if(!$volume){throw 'The camera is disconnected'}
   $plan=[Console]::In.ReadToEnd() | ConvertFrom-Json
   if($plan.device -ne $volume.identity){throw 'The camera or card changed'}
   Add-Type -Path (Join-Path $PSScriptRoot 'VerifiedCameraDelete.cs')
   $results=@(foreach($file in $plan.files){
    try{
     $current=Camera-Volume
     if(!$current -or $current.identity -ne $plan.device){throw 'The camera or card changed'}
     $path=Camera-Path $current $file.relativePath
     $record=Property-Value $source ($config.source.diskPnpId+'|'+$file.relativePath)
     $backup=if($record){Property-Value $state $record.destination}else{$null}
     if(!$record -or !$backup -or $record.checksum -ne $file.sha1 -or $backup.assetId -ne $file.assetId){throw 'Import verification state no longer matches'}
     $archive=Check-InboxPath $record.destination
     [CameraFileDelete]::DeleteVerified($path,$archive,[string]$file.sha1,[long]$file.bytes)
     @{id=$file.id;name=$file.name;deleted=$true}
    }catch{@{id=$file.id;name=$file.name;deleted=$false;error=$_.Exception.Message}}
   })
   $result=@{results=$results}
  }
 }
 [Console]::Write(($result | ConvertTo-Json -Depth 14 -Compress))
}catch{[Console]::Error.Write($_.Exception.Message);exit 1}
