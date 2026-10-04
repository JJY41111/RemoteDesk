param(
    [ValidateSet('text', 'image')][string]$Kind,
    [string]$InputPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try {
        if ($Kind -eq 'text') {
            $value = [System.IO.File]::ReadAllText($InputPath, [System.Text.Encoding]::UTF8)
            [System.Windows.Forms.Clipboard]::SetDataObject($value, $true)
        } else {
            Add-Type -AssemblyName System.Drawing
            $stream = [System.IO.File]::OpenRead($InputPath)
            try {
                $source = [System.Drawing.Image]::FromStream($stream)
                try {
                    $bitmap = New-Object System.Drawing.Bitmap $source
                    [System.Windows.Forms.Clipboard]::SetDataObject($bitmap, $true)
                } finally { $source.Dispose() }
            } finally { $stream.Dispose() }
        }
        exit 0
    } catch {
        if ($attempt -eq 4) { Write-Error $_; exit 1 }
        Start-Sleep -Milliseconds 100
    }
}
