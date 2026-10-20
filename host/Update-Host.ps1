#Requires -RunAsAdministrator
[CmdletBinding()]param([string]$BuildDirectory=(Join-Path $PSScriptRoot '..\out\system-host'))
$ErrorActionPreference='Stop'
$target=Join-Path $env:ProgramFiles 'RemoteDeskHost'
$service=Get-CimInstance Win32_Service -Filter "Name='RemoteDeskHost'"
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$expected='"'+(Join-Path $target 'remote_desk_host.exe')+'" --service '+$owner
if(!$service -or $service.PathName -ne $expected){throw 'Installed service identity/path does not match this owner.'}
if(@(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -in @((Join-Path $target 'remote_desk.exe'),(Join-Path $target 'remote_desk_input.exe'))
}).Count){throw 'Privileged helpers are active. Disconnect before updating.'}
$binaries=@('remote_desk_host.exe','remote_desk.exe','remote_desk_input.exe')
foreach($file in $binaries){if(!(Test-Path -LiteralPath (Join-Path $BuildDirectory $file))){throw "Missing build: $file"}}
$backup=Join-Path $target ('rollback-'+[guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($backup)|Out-Null
Stop-Service RemoteDeskHost
try{
    foreach($file in $binaries){
        $destination=Join-Path $target $file
        if((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Unexpected reparse point'}
        Copy-Item -LiteralPath $destination -Destination (Join-Path $backup $file)
        $temporary=Join-Path $target ([guid]::NewGuid().ToString()+'.new')
        Copy-Item -LiteralPath (Join-Path $BuildDirectory $file) -Destination $temporary
        Remove-Item -LiteralPath $destination
        Move-Item -LiteralPath $temporary -Destination $destination
    }
    Start-Service RemoteDeskHost
    & (Join-Path $target 'remote_desk_host.exe') --status
    if($LASTEXITCODE){throw 'Updated service status probe failed'}
}catch{
    Stop-Service RemoteDeskHost -ErrorAction SilentlyContinue
    foreach($file in $binaries){
        $saved=Join-Path $backup $file
        if(Test-Path -LiteralPath $saved){
            $destination=Join-Path $target $file
            if(Test-Path -LiteralPath $destination){Remove-Item -LiteralPath $destination}
            Move-Item -LiteralPath $saved -Destination $destination
        }
    }
    Start-Service RemoteDeskHost -ErrorAction SilentlyContinue
    throw
}
Write-Output 'RemoteDeskHost updated; previous binaries retained in the protected rollback directory.'
