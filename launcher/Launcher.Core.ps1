Set-StrictMode -Version Latest

function Read-RemoteDeskLog($Path, $MaxCharacters=0) {
    # Redirected logs stay open for writing while Node runs.
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $reader = New-Object IO.StreamReader -ArgumentList $stream
    try {
        if ($MaxCharacters -gt 0) {
            $chars = New-Object char[] $MaxCharacters
            $count = $reader.ReadBlock($chars, 0, $chars.Length)
            return [string]::new($chars, 0, $count)
        }
        return $reader.ReadToEnd()
    } finally { $reader.Dispose(); $stream.Dispose() }
}

function Get-RemoteDeskAddresses {
    $physical = @(Get-NetAdapter -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' -and $_.HardwareInterface })
    $entries = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop)
    foreach ($entry in $entries) {
        $address = $entry.IPAddress
        if ($entry.InterfaceAlias -match 'Tailscale' -and $address -match '^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.') {
            [pscustomobject]@{ Mode='wan'; Address=$address; Label="$address  ($($entry.InterfaceAlias))" }
        } elseif ($physical.ifIndex -contains $entry.InterfaceIndex -and $address -match '^(10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)') {
            [pscustomobject]@{ Mode='lan'; Address=$address; Label="$address  ($($entry.InterfaceAlias))" }
        }
    }
}

function New-RemoteDeskConfig($Root, $Mode, $HostAddress, $Port=0, $TcpPort=0) {
    $parsedAddress = $null
    if ($Mode -notin @('lan','wan') -or ![Net.IPAddress]::TryParse($HostAddress, [ref]$parsedAddress) -or
        $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw '請選擇有效的本機 IPv4。' }
    if (!$Port) { $Port = if ($Mode -eq 'wan') { 9443 } else { 8443 } }
    if (!$TcpPort) { $TcpPort = if ($Mode -eq 'wan') { 55445 } else { 5000 } }
    $private = Join-Path $Root 'bridge\private'
    $prefix = if ($Mode -eq 'wan') { 'tailnet' } else { 'lan' }
    [pscustomobject]@{ Root=$Root; Mode=$Mode; HostAddress=$HostAddress; Port=$Port; TcpPort=$TcpPort;
        Url="https://${HostAddress}:$Port/"; Stdout=(Join-Path $private "$prefix-current.stdout.log");
        Stderr=(Join-Path $private "$prefix-current.stderr.log");
        Metadata=(Join-Path $private "launcher-$Mode.json") }
}

function Get-RemoteDeskState($Config) {
    $listener = @(Get-NetTCPConnection -State Listen -LocalPort $Config.Port -ErrorAction SilentlyContinue)
    if (!$listener.Count) { return [pscustomobject]@{ Running=$false; Owned=$false; Code=''; ProcessId=0 } }
    $match = @($listener | Where-Object { $_.LocalAddress -eq $Config.HostAddress })
    if (!$match.Count) { throw "連接埠 $($Config.Port) 已被另一個位址的服務使用；未停止任何程式。" }
    $serviceId = $match[0].OwningProcess
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$serviceId" -ErrorAction Stop
    if (!$process -or $process.Name -ne 'node.exe' -or $process.CommandLine -notmatch '(?:^|[\\\s"])server\.mjs(?:["\s]|$)') {
        throw "連接埠 $($Config.Port) 被其他程式使用；未停止任何程式。"
    }
    $log = if (Test-Path -LiteralPath $Config.Stdout) { Read-RemoteDeskLog $Config.Stdout 8192 } else { '' }
    if ((Test-Path -LiteralPath $Config.Stdout) -and
        (Get-Item -LiteralPath $Config.Stdout).LastWriteTimeUtc -lt $process.CreationDate.ToUniversalTime()) {
        throw '找不到本次啟動的配對紀錄；請查看原啟動視窗，避免顯示舊配對碼。'
    }
    $urlPattern = [regex]::Escape($Config.Url.TrimEnd('/')) + '(?:\s|$)'
    if ($log -notmatch $urlPattern) { throw '服務已啟動，但無法核對連線紀錄；請檢查原本啟動視窗。' }
    $codeMatches = [regex]::Matches($log, 'One-time pairing code for this server run: (\d{8})')
    $code = if ($codeMatches.Count) { $codeMatches[$codeMatches.Count-1].Groups[1].Value } else { '' }
    $verifiedLocal = $false
    $stateFile = Join-Path $Config.Root "bridge\private\pairing-state-$($Config.Port).json"
    if (Test-Path -LiteralPath $stateFile) {
        try {
            $current = (Read-RemoteDeskLog $stateFile 8192) | ConvertFrom-Json
            if ($current.processId -eq $serviceId -and $current.host -eq $Config.HostAddress -and $current.port -eq $Config.Port -and $current.code -match '^\d{8}$') { $code = $current.code; $verifiedLocal = $true }
        } catch { }
    }
    $owned = $false
    $invalidIdentity = $false
    if (Test-Path -LiteralPath $Config.Metadata) {
        try {
            $saved = [IO.File]::ReadAllText($Config.Metadata) | ConvertFrom-Json
            $owned = $saved.ProcessId -eq $serviceId -and $saved.Root -eq $Config.Root -and
                $saved.StartTicks -eq (Get-Process -Id $serviceId).StartTime.ToUniversalTime().Ticks -and
                $process.CommandLine.Contains((Join-Path $Config.Root 'bridge\server.mjs'))
            $invalidIdentity = $saved.ProcessId -eq $serviceId -and !$owned
        } catch { $owned = $false }
    }
    [pscustomobject]@{ Running=$true; Owned=$owned; Manageable=($owned -or ($verifiedLocal -and !$invalidIdentity)); Code=$code; ProcessId=$serviceId }
}

function Start-RemoteDeskService($Config) {
    $state = Get-RemoteDeskState $Config
    if ($state.Running) { return $state }
    if (@(Get-NetTCPConnection -State Listen -LocalPort $Config.TcpPort -ErrorAction SilentlyContinue).Count) {
        throw "畫面傳輸連接埠 $($Config.TcpPort) 已被使用；未啟動重複服務。"
    }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    foreach ($required in @('bridge\node_modules\node-datachannel','out\remote_desk.exe','out\remote_desk_input.exe','out\remote_desk_audio.exe')) {
        if (!(Test-Path -LiteralPath (Join-Path $Config.Root $required))) { throw "缺少必要檔案：$required。請先完成專案安裝／建置。" }
    }
    $addresses = @(Get-RemoteDeskAddresses | Where-Object { $_.Mode -eq $Config.Mode -and $_.Address -eq $Config.HostAddress })
    if (!$addresses.Count) { throw '所選網路目前未連線；請重新整理網路。' }
    $private = Split-Path $Config.Stdout
    [IO.Directory]::CreateDirectory($private) | Out-Null
    foreach ($log in @($Config.Stdout, $Config.Stderr)) {
        if (Test-Path -LiteralPath $log) { Copy-Item -LiteralPath $log -Destination "$log.$([DateTime]::UtcNow.Ticks).bak" }
    }
    $server = Join-Path $Config.Root 'bridge\server.mjs'
    $arguments = @(('"' + $server + '"'), "--host=$($Config.HostAddress)", "--port=$($Config.Port)",
        "--tcp-port=$($Config.TcpPort)", '--enable-input', '--audio', '--display=0:0', '--gamepad=viiper')
    if ($Config.Mode -eq 'wan') { $arguments += '--tailnet' }
    $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory (Join-Path $Config.Root 'bridge') -WindowStyle Hidden -PassThru -RedirectStandardOutput $Config.Stdout -RedirectStandardError $Config.Stderr
    @{ ProcessId=$process.Id; StartTicks=$process.StartTime.ToUniversalTime().Ticks; Root=$Config.Root } |
        ConvertTo-Json | Set-Content -LiteralPath $Config.Metadata -Encoding UTF8
    [pscustomobject]@{ Running=$false; Owned=$true; Code=''; ProcessId=$process.Id }
}

function Invoke-RemoteDeskAdmin($Config, $Action, $InputData=@{}) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName=(Get-Command node.exe -ErrorAction Stop).Source
    $info.Arguments='"'+(Join-Path $Config.Root 'bridge\launcher-admin-client.mjs')+'"'
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.RedirectStandardInput=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $process=New-Object Diagnostics.Process
    $process.StartInfo=$info
    try {
        [void]$process.Start()
        $bytes=[Text.Encoding]::UTF8.GetBytes((@{url=$Config.Url;action=$Action;input=$InputData}|ConvertTo-Json -Compress))
        $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
        $process.StandardInput.Close()
        $text=$process.StandardOutput.ReadToEnd()
        $process.WaitForExit()
        $result=$text|ConvertFrom-Json
        if ($result.status -ne 200) { throw $result.error }
        return $result
    } finally { $process.Dispose() }
}

function Stop-RemoteDeskService($Config) {
    $state = Get-RemoteDeskState $Config
    if (!$state.Running) { return }
    if (!$state.Manageable) { throw '無法核對這個服務屬於目前專案，為避免誤停其他程式，請從原啟動視窗停止。' }
    # PID, process start time, absolute script path and root were checked above.
    # Let the server's normal session cleanup detach inputs before stopping.
    $connected = @(Get-NetTCPConnection -State Established -LocalPort $Config.TcpPort -ErrorAction SilentlyContinue)
    if ($connected.Count) { throw 'iPad仍在連線，請先按遠端「斷線」，再停止服務。' }
    Stop-Process -Id $state.ProcessId -ErrorAction Stop
    Wait-Process -Id $state.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
}
