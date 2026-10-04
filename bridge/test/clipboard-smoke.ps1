$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

if (-not [System.Windows.Forms.Clipboard]::ContainsText()) {
    throw 'Clipboard smoke test requires an existing text clipboard to restore.'
}

$original = [System.Windows.Forms.Clipboard]::GetText()
$temporary = [System.IO.Path]::GetTempFileName()
$helper = Join-Path $PSScriptRoot '..\clipboard.ps1'
$icon = Join-Path $PSScriptRoot '..\web\icons\remotedesk-180.png'
try {
    [System.IO.File]::WriteAllText($temporary, '剪貼簿測試 😀', [System.Text.Encoding]::UTF8)
    & powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File $helper text $temporary
    if ($LASTEXITCODE -ne 0 -or [System.Windows.Forms.Clipboard]::GetText() -ne '剪貼簿測試 😀') {
        throw 'Text clipboard test failed.'
    }
    & powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File $helper image $icon
    if ($LASTEXITCODE -ne 0 -or -not [System.Windows.Forms.Clipboard]::ContainsImage()) {
        throw 'Image clipboard test failed.'
    }
    $image = [System.Windows.Forms.Clipboard]::GetImage()
    if ($image.Width -ne 180 -or $image.Height -ne 180) {
        throw 'Image clipboard dimensions were incorrect.'
    }
    Write-Output 'Windows text and PNG clipboard passed; restoring original text.'
} finally {
    [System.Windows.Forms.Clipboard]::SetText($original)
    [System.IO.File]::Delete($temporary)
}
