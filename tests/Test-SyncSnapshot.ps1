$ErrorActionPreference='Stop'
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('camera-sync-status-test-'+[guid]::NewGuid().ToString('N'))
$bridge=Join-Path (Split-Path $PSScriptRoot) 'dashboard\CameraBridge.ps1'
function Save-Fixture($Value,[string]$Name){$Value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $fixture $Name) -Encoding UTF8}
function Assert-That([bool]$Condition,[string]$Message){if(!$Condition){throw $Message}}
function Snapshot {
 $output=& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $bridge -Action Snapshot -Root $fixture
 if($LASTEXITCODE -ne 0){throw 'Snapshot helper failed'}
 return ($output | ConvertFrom-Json)
}
try{
 $null=New-Item -ItemType Directory -Path (Join-Path $fixture 'private') -Force
 $config=@{inbox=$fixture;source=@{diskPnpId='TEST-NOT-A-CAMERA';name='Test camera';mediaRoots=@('DCIM')};extensions=@('.jpg');dateOverrides=@{};albumId='test-album';albumName='Test album'}
 Save-Fixture $config 'config.json'
 $source=@{};$completed=@{};$jobs=@{};$paths=@{}
 foreach($name in @('done','held','live')){
  $directory=Join-Path $fixture $name;$null=New-Item -ItemType Directory -Path $directory
  $filePath=Join-Path $directory 'TEST.JPG';[IO.File]::WriteAllText($filePath,('Disposable status fixture '+$name+'; never uploaded.'))
  if($name -eq 'held'){[IO.File]::SetLastWriteTimeUtc($filePath,[datetime]'2020-01-01T12:00:00Z')}
  $file=Get-Item -LiteralPath $filePath;$fp="$($file.Length):$($file.LastWriteTimeUtc.Ticks)";$paths[$name]=$filePath
  $hash=(Get-FileHash -LiteralPath $filePath -Algorithm SHA1).Hash.ToLowerInvariant()
  $source['TEST-NOT-A-CAMERA|'+$name]=@{destination=$filePath;checksum=$hash;fingerprint=$fp}
  $stage=if($name -eq 'held'){'needs-date'}elseif($name -eq 'live'){'uploading'}else{'retry'}
  $jobs['archive|'+$filePath]=@{stage=$stage;fingerprint=$fp;updatedAt=(Get-Date).ToString('o')}
  if($name -eq 'done'){$completed[$filePath]=@{assetId='test-asset';checksum=$hash;fingerprint=$fp}}
 }
 Save-Fixture $source 'private\source-state.json';Save-Fixture $completed 'private\state.json'
 $runtime=@{processId=$PID;processStartedAtTicks=[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks;files=$jobs}
 Save-Fixture $runtime 'private\file-status.json'
 $snapshot=Snapshot
 Assert-That (!$snapshot.camera.connected) 'Fixture must never connect to a real camera'
 Assert-That ($snapshot.files.Count -eq 3) 'Pending archive copies must survive disconnect, without filename collisions'
 $done=$snapshot.files|Where-Object archivePath -eq $paths.done
 $held=$snapshot.files|Where-Object archivePath -eq $paths.held
 $live=$snapshot.files|Where-Object archivePath -eq $paths.live
 Assert-That ($done.imported -and $done.assetId -eq 'test-asset') 'Completed import state must remain authoritative'
 Assert-That ($held.copied -and !$held.imported -and $held.needsDateReview) 'Date holds need a saved-copy state'
 Assert-That ($live.job.stage -eq 'uploading' -and $live.job.active) 'Live processing state must match its worker and file fingerprint'
 $runtime.processStartedAtTicks--
 Save-Fixture $runtime 'private\file-status.json';$snapshot=Snapshot
 Assert-That (!($snapshot.files|Where-Object archivePath -eq $paths.live).job.active) 'A different process lifetime must invalidate active state'
 $jobs['archive|'+$paths.live].fingerprint='changed'
 Save-Fixture $runtime 'private\file-status.json';$snapshot=Snapshot
 Assert-That ($null -eq ($snapshot.files|Where-Object archivePath -eq $paths.live).job) 'A changed file must not inherit the old upload state'
 $heldRecord=$source['TEST-NOT-A-CAMERA|held']
 $review=@{files=@(@{archivePath=$paths.held;sha1=$heldRecord.checksum;fingerprint=$heldRecord.fingerprint;takenAt='2026-10-29T17:00:00Z'})}
 $before=(Get-FileHash -LiteralPath $paths.held).Hash
 $start=[Diagnostics.ProcessStartInfo]::new()
 $start.FileName="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
 $start.Arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$bridge+'" -Action SetDates -Root "'+$fixture+'"'
 $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $process=[Diagnostics.Process]::new();$process.StartInfo=$start
 try{
  $null=$process.Start();$process.StandardInput.Write(($review|ConvertTo-Json -Depth 5 -Compress));$process.StandardInput.Close()
  $output=$process.StandardOutput.ReadToEnd();$failure=$process.StandardError.ReadToEnd();$process.WaitForExit()
  if($process.ExitCode -ne 0){throw ('Date review helper failed: '+$failure)}
 }finally{$process.Dispose()}
 $savedConfig=Get-Content -LiteralPath (Join-Path $fixture 'config.json') -Raw|ConvertFrom-Json
 Assert-That ($savedConfig.dateOverrides.PSObject.Properties[$heldRecord.checksum].Value -like '2026-10-29T17:00:00*') 'Date approval must be persisted against the exact checksum'
 Assert-That ((Get-FileHash -LiteralPath $paths.held).Hash -eq $before) 'Date review must preserve original file bytes'
 $snapshot=Snapshot
 Assert-That (!(($snapshot.files|Where-Object archivePath -eq $paths.held).needsDateReview)) 'Confirmed dates must clear the date hold without editing the photo'
 Write-Output 'PASS: pending archives, duplicate filenames, date holds, worker lifetime, fingerprint binding, date persistence and unchanged original bytes'
}finally{
 $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
 $resolved=[IO.Path]::GetFullPath($fixture)
 if(!$resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^camera-sync-status-test-[a-f0-9]{32}$'){throw 'Unsafe test cleanup path'}
 if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
