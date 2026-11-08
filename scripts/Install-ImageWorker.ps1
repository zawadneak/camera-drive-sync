param([Parameter(Mandatory=$true)][string]$PythonExePath,[string]$InstallRoot='D:\CameraSync')
$ErrorActionPreference='Stop'
if(!(Test-Path -LiteralPath (Join-Path $InstallRoot 'config.json'))){throw 'Install the camera importer first'}
& $PythonExePath -c 'import sys; assert sys.version_info >= (3, 11)'
if($LASTEXITCODE -ne 0){throw 'A working Python 3.11+ runtime is required'}
$environment=Join-Path $InstallRoot 'runtime\image-python'
& $PythonExePath -m venv $environment
if($LASTEXITCODE -ne 0){throw 'Unable to create the private image-worker environment'}
$python=Join-Path $environment 'Scripts\python.exe'
& $python -m pip install --disable-pip-version-check 'Pillow==13.0.0'
if($LASTEXITCODE -ne 0){throw 'Unable to install Pillow'}
$settingsPath=Join-Path $InstallRoot 'dashboard-settings.json'
$settings=Get-Content -LiteralPath $settingsPath -Raw|ConvertFrom-Json
$settings|Add-Member -NotePropertyName imagePython -NotePropertyValue $python -Force
$temporary=$settingsPath+'.tmp'
$settings|ConvertTo-Json|Set-Content -LiteralPath $temporary -Encoding UTF8
Move-Item -LiteralPath $temporary -Destination $settingsPath -Force
Write-Output 'Python preview worker configured. Deploy dashboard source and restart the dashboard task.'
