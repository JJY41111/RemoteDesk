$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Launcher.Core.ps1')
$root=Split-Path $PSScriptRoot
$ipad=New-RemoteDeskConfig $root lan 192.168.1.100
$pc=New-RemoteDeskConfig $root lan 192.168.1.100 -Client pc
$ipadWan=New-RemoteDeskConfig $root wan 100.64.0.10
$pcWan=New-RemoteDeskConfig $root wan 100.64.0.10 -Client pc
if($ipad.Port -ne 8443 -or $ipadWan.Port -ne 9443 -or $ipadWan.TcpPort -ne 55445){throw 'iPad ports changed'}
if(@($ipad.Port,$pc.Port,$ipadWan.Port,$pcWan.Port)|Group-Object|Where-Object Count -gt 1){throw 'HTTPS port collision'}
if(@($ipad.TcpPort,$pc.TcpPort,$ipadWan.TcpPort,$pcWan.TcpPort)|Group-Object|Where-Object Count -gt 1){throw 'Capture port collision'}
foreach($property in @('Private','Stdout','Stderr','Metadata')){if($ipad.$property -eq $pc.$property){throw "Shared path: $property"}}
Write-Output 'PASS: unchanged iPad ports; distinct PC ports, private configuration and lifecycle metadata.'
