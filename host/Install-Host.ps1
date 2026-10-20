#Requires -RunAsAdministrator
[CmdletBinding()]
param([string]$BuildDirectory = (Join-Path $PSScriptRoot '..\out\system-host'),
      [string]$OwnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.SecurityIdentifier]::new($OwnerSid)
if($identity.Value -notmatch '^S-1-5-21-(\d+-){3}\d+$'){throw 'Select a local interactive account SID, not a system/service account.'}
if($OwnerSid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){
    throw 'The approved owner must be the same administrator account running this installer.'
}
$target=Join-Path $env:ProgramFiles 'RemoteDeskHost'
$data=Join-Path $env:ProgramData 'RemoteDeskHost'
$binaries=@('remote_desk_host.exe','remote_desk.exe','remote_desk_input.exe')
foreach($file in $binaries){if(!(Test-Path -LiteralPath (Join-Path $BuildDirectory $file) -PathType Leaf)){throw "Missing build: $file"}}
if(Get-Service RemoteDeskHost -ErrorAction SilentlyContinue){throw 'Service already installed. Stop remote sessions and remove it before replacing the privileged binaries.'}
foreach($directory in @($target,$data)){
    if(Test-Path -LiteralPath $directory){
        $item=Get-Item -LiteralPath $directory
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Reparse point refused: $directory"}
        $owner=(Get-Acl -LiteralPath $directory).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if($owner -notin @('S-1-5-18','S-1-5-32-544')){throw "Existing directory is not administrator-owned: $directory"}
    }else{[IO.Directory]::CreateDirectory($directory)|Out-Null}
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    $acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @('S-1-5-18','S-1-5-32-544')){
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
    }
    $reader=if($directory -eq $target){'S-1-5-32-545'}else{$OwnerSid}
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($reader),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))
    Set-Acl -LiteralPath $directory -AclObject $acl
}
Start-Transcript -LiteralPath (Join-Path $data 'install.log') -Append | Out-Null
foreach($file in $binaries){
    $destination=Join-Path $target $file
    if((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint)){
        throw "Reparse point refused: $destination"
    }
    # Copy to a new name, then replace the directory entry. Never write through
    # an existing hard link that might point at a different privileged file.
    $temporary=Join-Path $target ([guid]::NewGuid().ToString()+'.new')
    Copy-Item -LiteralPath (Join-Path $BuildDirectory $file) -Destination $temporary
    if(Test-Path -LiteralPath $destination){Remove-Item -LiteralPath $destination -Force}
    Move-Item -LiteralPath $temporary -Destination $destination
}
$binary='"'+(Join-Path $target 'remote_desk_host.exe')+'" --service '+$OwnerSid
New-Service -Name RemoteDeskHost -DisplayName 'RemoteDesk privileged capture and input host' `
    -BinaryPathName $binary -StartupType Automatic -Description 'Fixed capture/input helpers for the approved local console owner. No network listener or arbitrary command execution.'|Out-Null
try{Start-Service RemoteDeskHost; & (Join-Path $target 'remote_desk_host.exe') --status
    if($LASTEXITCODE){throw 'Service IPC status check failed'}
}catch{Stop-Service RemoteDeskHost -ErrorAction SilentlyContinue; & sc.exe delete RemoteDeskHost|Out-Null;throw}
Write-Output 'RemoteDeskHost installed. Re-start RemoteDesk through the launcher to use it.'
Stop-Transcript | Out-Null
