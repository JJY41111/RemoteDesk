$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PC.Client.ps1')
foreach ($pair in @(
    @('https://192.168.1.100:8443/', 'https://192.168.1.100:8443/?client=pc'),
    @('https://100.64.0.10:9443/?client=ipad&x=1', 'https://100.64.0.10:9443/?x=1&client=pc'),
    @(' https://host.example:9443/ ', 'https://host.example:9443/?client=pc')
)) {
    if ((Get-RemoteDeskPCUrl $pair[0]) -ne $pair[1]) { throw "URL conversion failed: $($pair[0])" }
}
foreach ($bad in @('http://host/', 'file:///C:/Windows/', 'javascript:alert(1)',
    'https://user:secret@host/', 'https://host/app.js', 'https://host/#fragment', '')) {
    $rejected = $false
    try { $null = Get-RemoteDeskPCUrl $bad } catch { $rejected = $true }
    if (!$rejected) { throw "Invalid URL accepted: $bad" }
}
Write-Output 'PASS: HTTPS URL conversion, parameter replacement, invalid schemes, credentials and non-homepage rejection.'
