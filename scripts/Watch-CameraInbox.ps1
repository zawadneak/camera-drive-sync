param([string]$Root='D:\CameraSync',[switch]$Once,[switch]$DryRun,[string]$VerifyFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Net.Http
$config=Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
if($config.server -ne 'http://127.0.0.1:2283'){throw 'Camera sync is restricted to the configured local Immich server'}
$private=Join-Path $Root 'private'
$statePath=Join-Path $private 'state.json'
$statusPath=Join-Path $Root 'status.json'
$logPath=Join-Path $Root 'events.jsonl'
$files=@{}
$sourceFiles=@{}
$sourceStatePath=Join-Path $private 'source-state.json'
if(Test-Path -LiteralPath $sourceStatePath){
 $saved=Get-Content -LiteralPath $sourceStatePath -Raw | ConvertFrom-Json
 foreach($p in $saved.PSObject.Properties){$sourceFiles[$p.Name]=$p.Value}
}
if(Test-Path -LiteralPath $statePath){
 $saved=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
 foreach($p in $saved.PSObject.Properties){$files[$p.Name]=$p.Value}
}
function Write-Event([string]$Level,[string]$Event,[string]$File,[string]$Detail){
 [ordered]@{time=(Get-Date).ToString('o');level=$Level;event=$Event;file=$File;detail=$Detail} | ConvertTo-Json -Compress | Add-Content -LiteralPath $logPath -Encoding UTF8
}
function Save-Json($Value,[string]$Path){
 $temp=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
 $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temp -Encoding UTF8
 Move-Item -LiteralPath $temp -Destination $Path -Force
}
function Invoke-Api([string]$Method,[string]$Path,$Body){
 $request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method),($config.server+$Path))
 if($null -ne $Body){$request.Content=[Net.Http.StringContent]::new(($Body | ConvertTo-Json -Depth 8 -Compress),[Text.Encoding]::UTF8,'application/json')}
 try{
  $response=$client.SendAsync($request).GetAwaiter().GetResult()
  try{
   $text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
   if(!$response.IsSuccessStatusCode){throw "$Method $Path returned HTTP $([int]$response.StatusCode)"}
   if($text){return ($text | ConvertFrom-Json)}
  }finally{$response.Dispose()}
 }finally{$request.Dispose()}
}
function Get-Checksum([string]$Path){
 $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 $sha=[Security.Cryptography.SHA1]::Create()
 try{return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}
 finally{$sha.Dispose();$stream.Dispose()}
}
function Upload-Asset($File,[string]$Hash,[string]$CorrectedDate){
 $request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post,($config.server+'/api/assets'))
 $request.Headers.Add('x-immich-checksum',$Hash)
 $form=[Net.Http.MultipartFormDataContent]::new()
 # The original EXIF is preserved. Immich's metadata jobs recover capture dates.
 $created=$File.LastWriteTimeUtc.ToString('o')
 if($CorrectedDate){$created=([DateTimeOffset]::Parse($CorrectedDate)).UtcDateTime.ToString('o')}
 $form.Add([Net.Http.StringContent]::new($created),'fileCreatedAt')
 $form.Add([Net.Http.StringContent]::new($File.LastWriteTimeUtc.ToString('o')),'fileModifiedAt')
 # Use each multipart part's filename. A shared filename field also
 # overrides the sidecar name in Immich's upload filter.
 $stream=[IO.File]::Open($File.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 $part=[Net.Http.StreamContent]::new($stream)
 $part.Headers.ContentType=[Net.Http.Headers.MediaTypeHeaderValue]::new('application/octet-stream')
 $form.Add($part,'assetData',$File.Name)
 if($CorrectedDate){
  $stamp=[Security.SecurityElement]::Escape($CorrectedDate)
  $xml='<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" exif:DateTimeOriginal="'+$stamp+'" xmp:CreateDate="'+$stamp+'" photoshop:DateCreated="'+$stamp+'"/></rdf:RDF></x:xmpmeta>'
  $sidecar=[Net.Http.ByteArrayContent]::new([Text.Encoding]::UTF8.GetBytes($xml))
  $sidecar.Headers.ContentType=[Net.Http.Headers.MediaTypeHeaderValue]::new('application/xml')
  $form.Add($sidecar,'sidecarData',($File.Name+'.xmp'))
 }
 $request.Content=$form
 try{
  $response=$client.SendAsync($request).GetAwaiter().GetResult()
  try{
   $text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
   if(!$response.IsSuccessStatusCode){
    $reason=($text -replace '[\r\n]+',' ')
    if($reason.Length -gt 1200){$reason=$reason.Substring(0,1200)}
    foreach($credential in $client.DefaultRequestHeaders.GetValues('x-api-key')){$reason=$reason.Replace($credential,'[redacted]')}
    throw "Upload returned HTTP $([int]$response.StatusCode): $reason"
   }
   return ($text | ConvertFrom-Json)
  }finally{$response.Dispose()}
 }finally{$request.Dispose();$stream.Dispose()}
}
function Process-File($File,[switch]$ReadOnly){
 $fingerprint="$($File.Length):$($File.LastWriteTimeUtc.Ticks)"
 if(!$ReadOnly -and $files.ContainsKey($File.FullName) -and $files[$File.FullName].fingerprint -eq $fingerprint){return}
 if(!$ReadOnly -and (([datetime]::UtcNow-$File.LastWriteTimeUtc).TotalSeconds -lt $config.settleSeconds)){return}
 $hash=Get-Checksum $File.FullName
 $correctedDate=$null
 if($config.dateOverrides){$override=$config.dateOverrides.PSObject.Properties[$hash];if($override){$correctedDate=([DateTimeOffset]$override.Value).ToString('o')}}
 $check=Invoke-Api 'POST' '/api/assets/bulk-upload-check' @{assets=@(@{id='camera-file';checksum=$hash})}
 $match=$check.results[0]
 if($ReadOnly -or $DryRun){
  Write-Event 'info' 'verified-readonly' $File.Name $match.action
  return [pscustomobject]@{file=$File.Name;checksum=$hash;action=$match.action;existingAssetId=$match.assetId}
 }
 if(!$correctedDate -and $File.LastWriteTime.Year -lt 2021){
  Write-Event 'warning' 'camera-clock-needs-review' $File.Name 'Date precedes 2021; kept locally until its recording date is confirmed.'
  return
 }
 if($match.isTrashed){
  Write-Event 'warning' 'already-in-trash' $File.Name 'Skipped; restore it in Immich if wanted.'
  return
 }
 $assetId=$null
 $outcome='uploaded'
 if($match.action -eq 'reject' -and $match.reason -eq 'duplicate'){
  $assetId=$match.assetId;$outcome='existing-duplicate'
 }elseif($match.action -eq 'accept'){
  $uploaded=Upload-Asset $File $hash $correctedDate
  $assetId=$uploaded.id
 }else{throw 'Unexpected checksum-check response'}
 if(!$assetId){throw 'No asset ID returned'}
 $detail=Invoke-Api 'GET' ('/api/assets/'+$assetId) $null
 if(!$detail.id){throw 'Uploaded asset could not be verified'}
 $membership=Invoke-Api 'PUT' ('/api/albums/'+$config.albumId+'/assets') @{ids=@($assetId)}
 foreach($result in $membership){if(!$result.success -and $result.error -ne 'duplicate'){throw 'Album membership could not be confirmed'}}
 $files[$File.FullName]=@{fingerprint=$fingerprint;checksum=$hash;assetId=$assetId;completed=(Get-Date).ToString('o')}
 Save-Json $files $statePath
 Write-Event 'info' $outcome $File.Name $assetId
}
function Copy-CameraFiles {
 if(!$config.source -or $config.source.kind -ne 'usb-disk'){return @{connected=$false;copied=0}}
 $disk=Get-CimInstance Win32_DiskDrive -Filter "PNPDeviceID LIKE 'USBSTOR%'" | Where-Object PNPDeviceID -eq $config.source.diskPnpId
 if(!$disk){return @{connected=$false;copied=0}}
 $copied=0
 foreach($partition in Get-CimAssociatedInstance -InputObject $disk -Association Win32_DiskDriveToDiskPartition){
  foreach($drive in Get-CimAssociatedInstance -InputObject $partition -Association Win32_LogicalDiskToPartition){
   foreach($relativeRoot in $config.source.mediaRoots){
    $path=Join-Path ($drive.DeviceID+'\') $relativeRoot
    if(!(Test-Path -LiteralPath $path)){continue}
    foreach($file in Get-ChildItem -LiteralPath $path -Recurse -File | Where-Object {$_.Extension.ToLowerInvariant() -in $config.extensions}){
     $relative=$file.FullName.Substring(($drive.DeviceID+'\').Length)
     $sourceKey=$config.source.diskPnpId+'|'+$relative
     $fp="$($file.Length):$($file.LastWriteTimeUtc.Ticks)"
     $cached=$sourceFiles[$sourceKey]
     if($cached -and $cached.fingerprint -eq $fp -and (Test-Path -LiteralPath $cached.destination)){continue}
     $hash=Get-Checksum $file.FullName
     if($DryRun){Write-Event 'info' 'camera-copy-readonly' $file.Name $hash;continue}
     $directory=Join-Path (Join-Path $config.inbox $config.source.name) $hash
     $destination=Join-Path $directory $file.Name
     New-Item -ItemType Directory -Path $directory -Force | Out-Null
     $alreadyValid=(Test-Path -LiteralPath $destination) -and ((Get-Checksum $destination) -eq $hash)
     if(!$alreadyValid){
      $free=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($destination)).AvailableFreeSpace
      if($free -lt (2*$file.Length+1GB)){throw 'Not enough free space to safely copy and import the next file'}
      $temporary=$destination+'.partial'
      $inputStream=[IO.File]::Open($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
      try{
       $outputStream=[IO.File]::Open($temporary,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
       try{$inputStream.CopyTo($outputStream);$outputStream.Flush($true)}finally{$outputStream.Dispose()}
      }finally{$inputStream.Dispose()}
      if((Get-Checksum $temporary) -ne $hash){throw ('Copy checksum mismatch for '+$file.Name)}
      [IO.File]::SetLastWriteTimeUtc($temporary,$file.LastWriteTimeUtc)
      [IO.File]::SetCreationTimeUtc($temporary,$file.LastWriteTimeUtc)
      Move-Item -LiteralPath $temporary -Destination $destination -Force
      $copied++
      Write-Event 'info' 'copied-from-camera' $file.Name $destination
     }
     $sourceFiles[$sourceKey]=@{fingerprint=$fp;checksum=$hash;destination=$destination}
     Save-Json $sourceFiles $sourceStatePath
    }
   }
  }
 }
 return @{connected=$true;copied=$copied}
}
$mutex=[Threading.Mutex]::new($false,'Local\ImmichCameraSync')
$locked=$false
$client=$null
$wake=$null
try{
 [Diagnostics.Process]::GetCurrentProcess().PriorityClass='BelowNormal'
 try{$locked=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$locked=$true}
 if(!$locked -and !$Once -and !$VerifyFile){
  for($attempt=0;$attempt -lt 20 -and !$locked;$attempt++){
   try{$locked=$mutex.WaitOne(500)}catch [Threading.AbandonedMutexException]{$locked=$true}
  }
 }
 if(!$locked){if($Once -or $VerifyFile){throw 'Camera sync is already running'};exit}
 $encrypted=Get-Content -LiteralPath (Join-Path $private 'api-key.dpapi') -Raw
 $secure=ConvertTo-SecureString $encrypted.Trim()
 $key=[Net.NetworkCredential]::new('', $secure).Password
 $client=[Net.Http.HttpClient]::new()
 $client.Timeout=[TimeSpan]::FromMinutes(60)
 $client.DefaultRequestHeaders.Add('x-api-key',$key)
 $key=$null
 $wake=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::AutoReset,'Local\ImmichCameraSyncWake')
 if($VerifyFile){Process-File (Get-Item -LiteralPath $VerifyFile) -ReadOnly;exit}
 do{
  $status=[ordered]@{checkedAt=(Get-Date).ToString('o');state='Watching inbox';inbox=$config.inbox;album=$config.albumName;pending=0;errors=0;completed=$files.Count;cameraConfigured=($null -ne $config.source -and $config.source.kind -ne 'unconfigured')}
  try{
   $cameraResult=Copy-CameraFiles
   $status.cameraConnected=$cameraResult.connected
   $status.copiedThisScan=$cameraResult.copied
   $null=Invoke-Api 'GET' ('/api/albums/'+$config.albumId) $null
   $candidates=@(Get-ChildItem -LiteralPath $config.inbox -File -Recurse | Where-Object {$_.Extension.ToLowerInvariant() -in $config.extensions})
   foreach($file in $candidates){
    $fp="$($file.Length):$($file.LastWriteTimeUtc.Ticks)"
    if($files.ContainsKey($file.FullName) -and $files[$file.FullName].fingerprint -eq $fp){continue}
    $status.pending++
    try{
     $null=Process-File $file
     if($files.ContainsKey($file.FullName) -and $files[$file.FullName].fingerprint -eq $fp){$status.pending--}
    }catch{$status.errors++;Write-Event 'error' 'retry-later' $file.Name $_.Exception.Message}
   }
   $status.completed=$files.Count
   if($status.errors){$status.state='Retrying incomplete files'}
  }catch{$status.state='Waiting for Immich';$status.errors++;Write-Event 'error' 'server-unavailable' '' $_.Exception.Message}
  Save-Json $status $statusPath
  if(!$Once){$null=$wake.WaitOne([int]$config.pollSeconds*1000)}
 }while(!$Once)
}finally{
 if($client){$client.Dispose()}
 if($wake){$wake.Dispose()}
 if($locked){$mutex.ReleaseMutex()}
 $mutex.Dispose()
}
