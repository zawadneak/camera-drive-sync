$ErrorActionPreference='Stop'
$base=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
$root=Join-Path $base ('camera-dashboard-delete-test-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
Add-Type -Path (Join-Path (Split-Path $PSScriptRoot) 'dashboard\VerifiedCameraDelete.cs')
function Make-Pair([string]$Name){$camera=Join-Path $root ($Name+'-camera.bin');$archive=Join-Path $root ($Name+'-archive.bin');[IO.File]::WriteAllText($camera,'temporary deletion test fixture');Copy-Item -LiteralPath $camera -Destination $archive;return @{camera=$camera;archive=$archive;hash=(Get-FileHash -LiteralPath $camera -Algorithm SHA1).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $camera).Length}}
try{
 $p=Make-Pair 'match';[CameraFileDelete]::DeleteVerified($p.camera,$p.archive,$p.hash,$p.bytes);if((Test-Path -LiteralPath $p.camera) -or !(Test-Path -LiteralPath $p.archive)){throw 'Verified deletion did not preserve the archive'}
 $p=Make-Pair 'wrong-source';[IO.File]::WriteAllText($p.camera,'changed camera file');try{[CameraFileDelete]::DeleteVerified($p.camera,$p.archive,$p.hash,$p.bytes);throw 'Expected rejection'}catch{if(!(Test-Path -LiteralPath $p.camera)){throw 'Changed source was deleted'}}
 $p=Make-Pair 'wrong-backup';[IO.File]::WriteAllText($p.archive,'changed backup');try{[CameraFileDelete]::DeleteVerified($p.camera,$p.archive,$p.hash,$p.bytes);throw 'Expected rejection'}catch{if(!(Test-Path -LiteralPath $p.camera)){throw 'Unverified source was deleted'}}
 $p=Make-Pair 'locked';$lock=[IO.File]::Open($p.camera,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{try{[CameraFileDelete]::DeleteVerified($p.camera,$p.archive,$p.hash,$p.bytes);throw 'Expected rejection'}catch{if(!(Test-Path -LiteralPath $p.camera)){throw 'Locked source was deleted'}}}finally{$lock.Dispose()}
 $p=Make-Pair 'same-path';try{[CameraFileDelete]::DeleteVerified($p.camera,$p.camera,$p.hash,$p.bytes);throw 'Expected rejection'}catch{if(!(Test-Path -LiteralPath $p.camera)){throw 'Same-path source was deleted'}}
 'Five Windows deletion safety scenarios passed using temporary fixtures only.'
}finally{
 $resolved=[IO.Path]::GetFullPath($root)
 if(!$resolved.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^camera-dashboard-delete-test-[a-f0-9]{32}$'){throw 'Refusing to clean an unexpected test directory'}
 Remove-Item -LiteralPath $resolved -Recurse -Force
}
