$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Launcher.Core.ps1')
$root=Split-Path $PSScriptRoot
$addresses=@(Get-RemoteDeskAddresses)
$lan=@($addresses | Where-Object {$_.Mode -eq 'lan'})[0].Address
$config=New-RemoteDeskConfig $root 'lan' $lan 19561 19562
$config.Metadata=Join-Path $root 'bridge\private\launcher-smoke.json'
$config.Stdout=Join-Path $root 'bridge\private\launcher-smoke.stdout.log'
$config.Stderr=Join-Path $root 'bridge\private\launcher-smoke.stderr.log'
$started=$null
if((Get-RemoteDeskState $config).Running){throw 'Isolated test port already occupied'}
try {
    $started=Start-RemoteDeskService $config
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 200
        try {$state=Get-RemoteDeskState $config} catch { $state=$null }
    } while((!$state -or !$state.Running -or !$state.Code) -and [DateTime]::UtcNow -lt $deadline)
    if(!$state -or !$state.Running -or !$state.Owned -or $state.Code -notmatch '^\d{8}$'){throw 'Launcher startup or pairing info failed'}
    $again=Start-RemoteDeskService $config
    if($again.ProcessId -ne $started.ProcessId){throw 'Repeated start created another process'}
    $savedMetadata=[IO.File]::ReadAllText($config.Metadata)
    $badMetadata=$savedMetadata | ConvertFrom-Json
    $badMetadata.StartTicks=0
    $badMetadata | ConvertTo-Json | Set-Content -LiteralPath $config.Metadata -Encoding UTF8
    $rejected=$false
    try { Stop-RemoteDeskService $config } catch { $rejected=$true }
    if(!$rejected -or !(Get-Process -Id $started.ProcessId -ErrorAction SilentlyContinue)){throw 'Stale process identity was not protected'}
    [IO.File]::WriteAllText($config.Metadata,$savedMetadata)
    Remove-Item -LiteralPath $config.Metadata
    if (!(Get-RemoteDeskState $config).Manageable) { throw 'Verified existing project service cannot be managed' }
    Stop-RemoteDeskService $config
    Start-Sleep -Milliseconds 300
    if((Get-RemoteDeskState $config).Running){throw 'Stop failed'}
    Write-Output 'Isolated startup, pairing information, repeated-start reuse, ownership and stop passed.'
    foreach($mode in @('lan','wan')) {
        $ip=@($addresses | Where-Object {$_.Mode -eq $mode})[0].Address
        $live=Get-RemoteDeskState (New-RemoteDeskConfig $root $mode $ip)
        if(!$live.Running -or !$live.Manageable -or $live.Code -notmatch '^\d{8}$'){throw 'Existing service attachment failed'}
        Write-Output "Existing $mode service verified for management (not stopped): PID $($live.ProcessId)."
    }
} finally {
    if($started -and (Get-Process -Id $started.ProcessId -ErrorAction SilentlyContinue)){Stop-Process -Id $started.ProcessId}
}
