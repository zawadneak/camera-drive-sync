param([Parameter(Mandatory=$true)][ValidateSet('Snapshot','Secret','Delete','Wake','SetDates')][string]$Action,[string]$Root='D:\CameraSync')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$config=Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
function Read-Json([string]$Path){if(Test-Path -LiteralPath $Path){return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)};return $null}
function Property-Value($Object,[string]$Name){if($Object){$p=$Object.PSObject.Properties[$Name];if($p){return $p.Value}};return $null}
function File-Job([string]$Key,[string]$Fingerprint){
 $job=Property-Value $runtime.files $Key
 if($job -and $job.fingerprint -eq $Fingerprint){return @{stage=$job.stage;updatedAt=$job.updatedAt;active=$runtimeActive}}
 return $null
}
function Camera-Volume {
 $disk=Get-CimInstance Win32_DiskDrive -Filter "PNPDeviceID LIKE 'USBSTOR%'" | Where-Object PNPDeviceID -eq $config.source.diskPnpId
 if(!$disk){return $null}
 foreach($partition in Get-CimAssociatedInstance -InputObject $disk -Association Win32_DiskDriveToDiskPartition){
  foreach($drive in Get-CimAssociatedInstance -InputObject $partition -Association Win32_LogicalDiskToPartition){
   if(Test-Path -LiteralPath (Join-Path ($drive.DeviceID+'\') 'DCIM')){
    $storage=$null
    if($null -ne $drive.Size -and $null -ne $drive.FreeSpace -and [double]$drive.Size -gt 0){
     $total=[double]$drive.Size;$free=[Math]::Max([double]0,[Math]::Min($total,[double]$drive.FreeSpace));$used=$total-$free
     $storage=@{totalBytes=$total;freeBytes=$free;usedBytes=$used;usedPercent=[Math]::Round(100*$used/$total,1)}
    }
    return @{root=($drive.DeviceID+'\');serial=$drive.VolumeSerialNumber;identity=($disk.PNPDeviceID+'|'+$drive.VolumeSerialNumber);storage=$storage}
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
 }elseif($Action -eq 'SetDates'){
  $plan=([Console]::In.ReadToEnd()).TrimStart([char]0xFEFF) | ConvertFrom-Json
  if(!$plan.files -or @($plan.files).Count -gt 10000){throw 'Invalid date review selection'}
  $source=Read-Json (Join-Path $Root 'private\source-state.json')
  $completed=Read-Json (Join-Path $Root 'private\state.json')
  $changes=@{}
  foreach($file in $plan.files){
   if($file.sha1 -notmatch '^[a-f0-9]{40}$'){throw 'Invalid original checksum'}
   $archive=Check-InboxPath $file.archivePath
   $info=Get-Item -LiteralPath $archive
   $fp="$($info.Length):$($info.LastWriteTimeUtc.Ticks)"
   if($fp -ne $file.fingerprint){throw 'A selected PC copy changed. Refresh the date review.'}
   $record=$source.PSObject.Properties | Where-Object {$_.Value.destination -eq $archive -and $_.Value.checksum -eq $file.sha1} | Select-Object -First 1
   $backup=Property-Value $completed $archive
   if(!$record -or ($backup -and $backup.fingerprint -eq $fp)){throw 'This original is no longer awaiting import'}
   if((Get-FileHash -LiteralPath $archive -Algorithm SHA1).Hash.ToLowerInvariant() -ne $file.sha1){throw 'The saved original failed verification'}
   if($file.takenAt -notmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?(Z|[+-]\d\d:\d\d)$'){throw 'Invalid confirmed recording time'}
   $stamp=([DateTimeOffset]::Parse($file.takenAt)).ToString('o')
   if($changes.ContainsKey($file.sha1) -and $changes[$file.sha1] -ne $stamp){throw 'Identical originals cannot have conflicting dates'}
   $changes[$file.sha1]=$stamp
  }
  $overrides=@{}
  foreach($property in $config.dateOverrides.PSObject.Properties){$overrides[$property.Name]=$property.Value}
  foreach($checksum in $changes.Keys){$overrides[$checksum]=$changes[$checksum]}
  $config.dateOverrides=$overrides
  $configPath=Join-Path $Root 'config.json';$temporary=$configPath+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
  try{$config | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding UTF8;Move-Item -LiteralPath $temporary -Destination $configPath -Force}finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
  $result=@{updated=@($plan.files).Count}
 }else{
  $source=Read-Json (Join-Path $Root 'private\source-state.json')
  $state=Read-Json (Join-Path $Root 'private\state.json')
  $volume=Camera-Volume
  if($Action -eq 'Snapshot'){
   $runtime=Read-Json (Join-Path $Root 'private\file-status.json');$runtimeActive=$false
   if($runtime.processId -and $runtime.processStartedAtTicks){
    $worker=Get-Process -Id $runtime.processId -ErrorAction SilentlyContinue
    if($worker){$runtimeActive=($worker.StartTime.ToUniversalTime().Ticks -eq $runtime.processStartedAtTicks)}
   }
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
      $copied=($record -and $record.fingerprint -eq $fingerprint -and (Test-Path -LiteralPath $record.destination))
      $imported=($copied -and $backup -and $backup.fingerprint -eq $fingerprint -and $record.checksum -eq $backup.checksum)
      $date=$file.LastWriteTime.ToString('o')
      $override=if($record){Property-Value $config.dateOverrides $record.checksum}else{$null}
      if($override){$date=([DateTimeOffset]$override).ToString('o')}
      $job=if($copied){File-Job ('archive|'+$record.destination) $fingerprint}else{$null}
      if(!$job){$job=File-Job ('camera|'+$config.source.diskPnpId+'|'+$relative) $fingerprint}
      $rows.Add(@{id=(File-Id ($volume.identity+'|'+$relative));name=$file.Name;relativePath=$relative;cameraPath=$file.FullName;bytes=$file.Length;fingerprint=$fingerprint;capturedAt=$date;type=$(if($file.Extension -match '^\.(mp4|mov|mts|m2ts)$'){'video'}else{'photo'});onCamera=$true;imported=[bool]$imported;copied=[bool]$copied;needsDateReview=(!$override -and $file.LastWriteTime.Year -lt 2021);job=$job;outcome=$(if($imported){$backup.outcome}else{$null});sha1=$(if($record){$record.checksum}else{$null});archivePath=$(if($record){$record.destination}else{$null});assetId=$(if($imported){$backup.assetId}else{$null})})
      if($copied){$null=$seen.Add($record.destination)}
     }
    }
   }
   $archivePaths=@(@($state.PSObject.Properties | ForEach-Object {$_.Name})+@($source.PSObject.Properties | ForEach-Object {$_.Value.destination}) | Where-Object {$_} | Select-Object -Unique)
   foreach($archivePath in $archivePaths){
    if($seen.Contains($archivePath)){continue}
    $file=Get-Item -LiteralPath $archivePath -ErrorAction SilentlyContinue
    if(!$file){continue}
    $backup=Property-Value $state $archivePath
    $record=$source.PSObject.Properties | Where-Object {$_.Value.destination -eq $archivePath} | Select-Object -First 1
    $checksum=if($record){$record.Value.checksum}elseif($backup){$backup.checksum}else{$null}
    $fingerprint="$($file.Length):$($file.LastWriteTimeUtc.Ticks)"
    $imported=($backup -and $backup.fingerprint -eq $fingerprint)
    $override=Property-Value $config.dateOverrides $checksum
    $date=if($override){([DateTimeOffset]$override).ToString('o')}else{$file.LastWriteTime.ToString('o')}
    $rows.Add(@{id=(File-Id ('archive|'+$archivePath));name=$file.Name;relativePath=$null;bytes=$file.Length;fingerprint=$fingerprint;capturedAt=$date;type=$(if($file.Extension -match '^\.(mp4|mov|mts|m2ts)$'){'video'}else{'photo'});onCamera=$false;imported=[bool]$imported;copied=$true;needsDateReview=(!$override -and $file.LastWriteTime.Year -lt 2021);job=(File-Job ('archive|'+$archivePath) $fingerprint);outcome=$(if($imported){$backup.outcome}else{$null});sha1=$checksum;archivePath=$archivePath;assetId=$(if($imported){$backup.assetId}else{$null})})
   }
   $activity=@(Get-Content -LiteralPath (Join-Path $Root 'events.jsonl') -Tail 18 -ErrorAction SilentlyContinue | ForEach-Object {try{$_ | ConvertFrom-Json}catch{}})
   $result=@{camera=@{connected=[bool]$volume;name=$config.source.name;identity=$(if($volume){$volume.identity}else{$null});drive=$(if($volume){$volume.root}else{$null});storage=$(if($volume){$volume.storage}else{$null})};importer=(Read-Json (Join-Path $Root 'status.json'));album=@{id=$config.albumId;name=$config.albumName};files=@($rows);activity=$activity}
  }else{
   if(!$volume){throw 'The camera is disconnected'}
   $plan=([Console]::In.ReadToEnd()).TrimStart([char]0xFEFF) | ConvertFrom-Json
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
