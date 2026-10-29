param([string]$Root='D:\CameraSync')
$ErrorActionPreference='Stop'
try{
 $settings=Get-Content -LiteralPath (Join-Path $Root 'dashboard-settings.json') -Raw | ConvertFrom-Json
 Add-Type -Path (Join-Path $Root 'dashboard\ProcessSupervisor.cs')
 $code=[CameraDashboardSupervisor]::Run((Join-Path $Root 'runtime\node.exe'),(Join-Path $Root 'dashboard\server.mjs'),$Root,[int]$settings.port,(Join-Path $Root 'private\dashboard.log'))
 exit $code
}catch{Write-Error $_;exit 1}
