param([string]$Root='D:\CameraSync')
$ErrorActionPreference='Stop'
try{
 $settings=Get-Content -LiteralPath (Join-Path $Root 'dashboard-settings.json') -Raw | ConvertFrom-Json
 $arguments=@(('"'+(Join-Path $Root 'dashboard\server.mjs')+'"'),'--root',('"'+$Root+'"'),'--port',[string]$settings.port)
 $process=Start-Process -FilePath (Join-Path $Root 'runtime\node.exe') -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $Root 'private\dashboard.stdout.log') -RedirectStandardError (Join-Path $Root 'private\dashboard.stderr.log')
 exit $process.ExitCode
}catch{Write-Error $_;exit 1}
