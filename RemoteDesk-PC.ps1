param([string]$Url, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'launcher\PC.Client.ps1')
if ($ValidateOnly) { Get-RemoteDeskPCUrl $Url; return }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text = 'RemoteDesk 電腦接收端'
$form.ClientSize = New-Object Drawing.Size(650,255)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Microsoft JhengHei UI',11)
$form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false
$hint = New-Object Windows.Forms.Label
$hint.Text = '貼上桌機啟動器的連線網址；配對碼在瀏覽器內輸入。'
$hint.SetBounds(22,22,610,32); $form.Controls.Add($hint)
$field = New-Object Windows.Forms.TextBox
$field.SetBounds(22,67,606,32); $field.Text = $Url; $form.Controls.Add($field)
$button = New-Object Windows.Forms.Button
$button.Text = '開啟電腦接收頁'; $button.SetBounds(22,115,220,42)
$form.Controls.Add($button); $form.AcceptButton = $button
$detail = New-Object Windows.Forms.Label
$detail.SetBounds(22,170,606,70)
$detail.Text = '使用 Edge／Chrome。跨網路時兩台電腦須連上同一個 Tailscale 網路。首次連線請依主機的憑證說明設定信任。'
$form.Controls.Add($detail)
$button.Add_Click({
    try { Start-Process -FilePath (Get-RemoteDeskPCUrl $field.Text) }
    catch { $detail.Text = $_.Exception.Message }
})
[void]$form.ShowDialog(); $form.Dispose()
