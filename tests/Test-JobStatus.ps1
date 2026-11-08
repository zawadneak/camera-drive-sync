$ErrorActionPreference='Stop'
# Exercise the actual status writer without starting the importer or touching media.
$scriptPath=Join-Path (Split-Path $PSScriptRoot) 'scripts\Watch-CameraInbox.ps1'
$tokens=$null;$errors=$null
$tree=[Management.Automation.Language.Parser]::ParseFile($scriptPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Watcher must parse without errors'}
$function=$tree.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Set-FileStage'},$true)
. ([scriptblock]::Create($function.Extent.Text))
function Save-Json($Value,[string]$Path){}
$DryRun=$false;$VerifyFile=$null;$fileStages=@{};$files=@{};$status=@{};$fileStatusPath='unused';$statusPath='unused';$processStartedAtTicks=0
foreach($key in @('camera|USBSTOR\DISK&VEN_TEST\SERIAL&0|DCIM\100MSDCF\TEST.JPG','archive|D:\Inbox\TEST.JPG')){
 Set-FileStage $key '123:456' 'copying'
 if($status.currentFile -ne 'TEST.JPG'){throw 'The display filename must exclude job/device identifiers'}
 if($status.stage -ne 'copying' -or !$fileStages.ContainsKey($key)){throw 'Full job keys and status must be preserved'}
}
Write-Output 'PASS: camera and archive job keys update status without invalid-path errors'
