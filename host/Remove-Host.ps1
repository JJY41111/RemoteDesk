#Requires -RunAsAdministrator
[CmdletBinding()] param()
$ErrorActionPreference='Stop'
$service=Get-Service RemoteDeskHost -ErrorAction SilentlyContinue
if($service){Stop-Service RemoteDeskHost; & sc.exe delete RemoteDeskHost
    if($LASTEXITCODE){throw 'Service removal failed'} }
Write-Output 'Service removed. Protected binaries/logs retained; restart RemoteDesk for ordinary mode.'
