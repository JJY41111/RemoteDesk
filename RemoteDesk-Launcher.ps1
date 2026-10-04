param([switch]$Preview, [string]$PreviewPath, [int]$PreviewTab=0, [switch]$ValidateLive, [switch]$ValidatePasswordFlow, [switch]$ValidateServiceButtons)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
. (Join-Path $PSScriptRoot 'launcher\Launcher.Core.ps1')
$form = New-Object Windows.Forms.Form
$form.Text = 'RemoteDesk 啟動器'
$form.ClientSize = New-Object Drawing.Size(940,700)
$form.MinimumSize = New-Object Drawing.Size(850,710)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [Drawing.Color]::FromArgb(245,247,251)
$form.Font = New-Object Drawing.Font('Microsoft JhengHei UI',11)

function Add-Label($Parent, $Text, $X, $Y, $Width, $Height) {
    $label = New-Object Windows.Forms.Label
    $label.Text=$Text; $label.SetBounds($X,$Y,$Width,$Height)
    $Parent.Controls.Add($label); return $label
}
function Add-Button($Parent,$Text,$X,$Y,$Width) {
    $button = New-Object Windows.Forms.Button
    $button.Text=$Text; $button.SetBounds($X,$Y,$Width,42)
    $button.FlatStyle='Flat'; $button.FlatAppearance.BorderSize=0
    $button.BackColor=[Drawing.Color]::FromArgb(226,233,243)
    $Parent.Controls.Add($button); return $button
}
function Add-Field($Parent,$X,$Y,$Width) {
    $field = New-Object Windows.Forms.TextBox
    $field.ReadOnly=$true; $field.SetBounds($X,$Y,$Width,32)
    $field.Font=New-Object Drawing.Font('Segoe UI',13)
    $Parent.Controls.Add($field); return $field
}
$title = Add-Label $form 'RemoteDesk' 26 20 430 40
$title.Font = New-Object Drawing.Font('Segoe UI',23,[Drawing.FontStyle]::Bold)
$null = Add-Label $form '選擇連線方式，按「開始」；不用開終端機。' 28 68 850 30
$tabs=New-Object Windows.Forms.TabControl
$tabs.SetBounds(24,112,892,560); $tabs.Anchor='Top,Bottom,Left,Right'
$form.Controls.Add($tabs)
$script:pages=@()
foreach ($mode in @('lan','wan')) {
    $tab=New-Object Windows.Forms.TabPage
    $tab.Text=if($mode -eq 'lan'){'同網路 iPad'}else{'跨網路 iPad'}
    $tab.BackColor=[Drawing.Color]::White; $tabs.TabPages.Add($tab)
    $hint=if($mode -eq 'lan'){'PC與iPad連上同一個Wi-Fi／區域網路即可。'}else{'PC與iPad都必須連上同一個Tailscale帳號的網路。'}
    $null=Add-Label $tab $hint 24 20 800 30
    $null=Add-Label $tab '主機網路位址' 24 67 160 26
    $network=New-Object Windows.Forms.ComboBox
    $network.DropDownStyle='DropDownList'; $network.DisplayMember='Label'
    $network.SetBounds(24,98,590,34); $tab.Controls.Add($network)
    $refresh=Add-Button $tab '重新整理網路' 636 94 200
    $start=Add-Button $tab '開始' 24 155 145
    $start.BackColor=[Drawing.Color]::FromArgb(38,101,211); $start.ForeColor=[Drawing.Color]::White
    $stop=Add-Button $tab '停止服務' 184 155 145; $stop.Enabled=$false
    $state=Add-Label $tab '尚未啟動' 354 164 482 34
    $null=Add-Label $tab '在iPad開啟此網址' 24 218 400 25
    $url=Add-Field $tab 24 247 590
    $copyUrl=Add-Button $tab '複製網址' 636 242 200
    $null=Add-Label $tab '本次配對碼' 24 300 400 25
    $code=Add-Field $tab 24 330 510
    $code.PasswordChar='*'
    $eye=Add-Button $tab '👁' 550 325 64
    $eye.Font=New-Object Drawing.Font('Segoe UI Emoji',14)
    $eye.Tag=$code
    $eye.Add_Click({if($this.Tag.PasswordChar -eq '*'){$this.Tag.PasswordChar=[char]0}else{$this.Tag.PasswordChar='*'}})
    $copyCode=Add-Button $tab '複製配對碼' 636 325 200
    $change=Add-Button $tab '修改配對碼' 24 386 200
    $detail=Add-Label $tab '啟動後會顯示配對資訊；關閉此視窗不會停止遠端服務。' 24 444 812 68
    $detail.ForeColor=[Drawing.Color]::FromArgb(80,94,111)
    $page=[pscustomobject]@{Mode=$mode;Network=$network;Start=$start;Stop=$stop;State=$state;Url=$url;Code=$code;Detail=$detail;Config=$null;PendingAt=$null}
    $script:pages += $page
    foreach($button in @($start,$stop,$refresh,$copyUrl,$copyCode,$change)){$button.Tag=$page}
    $change.Add_Click({
        try {
            if(!$this.Tag.Config -or !(Get-RemoteDeskState $this.Tag.Config).Running){throw '請先開始遠端服務。'}
            Show-PairingEditor $this.Tag
        } catch {$this.Tag.Detail.Text=$_.Exception.Message}
    })
    $refresh.Add_Click({ Refresh-Networks $this.Tag })
    $start.Add_Click({
        $page=$this.Tag
        try {
            if(!$page.Network.SelectedItem){throw '沒有可用網路；跨網路模式請先連上Tailscale。'}
            $page.Config=New-RemoteDeskConfig $PSScriptRoot $page.Mode $page.Network.SelectedItem.Address
            $result=Start-RemoteDeskService $page.Config
            if(!$result.Running){$page.PendingAt=[DateTime]::UtcNow;$page.State.Text='正在啟動…';$page.Start.Enabled=$false}
            Update-Page $page
        } catch {$page.State.Text='無法啟動';$page.Detail.Text=$_.Exception.Message;$page.Start.Enabled=$true}
    })
    $stop.Add_Click({
        try {
            $this.Enabled=$false;$this.Tag.State.Text='正在停止…';$form.Refresh()
            Stop-RemoteDeskService $this.Tag.Config
            Update-Page $this.Tag
            $this.Tag.Detail.Text='服務已停止；按「開始」可重新啟動。'
        } catch {
            Update-Page $this.Tag
            [void][Windows.Forms.MessageBox]::Show($form,$_.Exception.Message,'無法停止服務')
        }
    })
    $copyUrl.Add_Click({if($this.Tag.Url.Text){[Windows.Forms.Clipboard]::SetText($this.Tag.Url.Text)}})
    $copyCode.Add_Click({if($this.Tag.Code.Text){[Windows.Forms.Clipboard]::SetText($this.Tag.Code.Text)}})
}
function Add-SecretField($Parent,$Y) {
    $secret=Add-Field $Parent 24 $Y 332
    $secret.ReadOnly=$false; $secret.PasswordChar='*'; $secret.MaxLength=128
    $eye=Add-Button $Parent '👁' 372 ($Y-5) 64
    $eye.Font=New-Object Drawing.Font('Segoe UI Emoji',14);$eye.Tag=$secret
    $eye.Add_Click({if($this.Tag.PasswordChar -eq '*'){$this.Tag.PasswordChar=[char]0}else{$this.Tag.PasswordChar='*'}})
    return $secret
}
function Show-PairingEditor($Page) {
    $admin=Invoke-RemoteDeskAdmin $Page.Config 'status'
    if(!$admin.configured){
        $setup=New-Object Windows.Forms.Form
        $setup.Text='首次設定管理密碼';$setup.ClientSize=New-Object Drawing.Size(465,310)
        $setup.StartPosition='CenterParent';$setup.FormBorderStyle='FixedDialog';$setup.MaximizeBox=$false;$setup.MinimizeBox=$false;$setup.Font=$form.Font
        $null=Add-Label $setup '每次修改配對碼時都需輸入此密碼（至少8字）。' 24 20 418 46
        $first=Add-SecretField $setup 86
        $null=Add-Label $setup '再次輸入管理密碼' 24 132 418 26
        $second=Add-SecretField $setup 165
        $save=Add-Button $setup '設定管理密碼' 24 227 200
        $save.Add_Click({
            try {
                $null=Invoke-RemoteDeskAdmin $Page.Config 'setup' @{password=$first.Text;confirmPassword=$second.Text}
                $setup.DialogResult='OK';$setup.Close()
            } catch {[void][Windows.Forms.MessageBox]::Show($setup,$_.Exception.Message,'無法設定')}
        })
        $result=$setup.ShowDialog($form);$first.Text='';$second.Text='';$setup.Dispose()
        if($result -ne 'OK'){return}
    }
    $editor=New-Object Windows.Forms.Form
    $editor.Text='驗證管理密碼並修改配對碼';$editor.ClientSize=New-Object Drawing.Size(465,365)
    $editor.StartPosition='CenterParent';$editor.FormBorderStyle='FixedDialog';$editor.MaximizeBox=$false;$editor.MinimizeBox=$false;$editor.Font=$form.Font
    $null=Add-Label $editor '輸入管理密碼' 24 20 418 26
    $password=Add-SecretField $editor 58
    $null=Add-Label $editor '新的8位數配對碼' 24 116 418 26
    $newCode=Add-SecretField $editor 153;$newCode.MaxLength=8
    $null=Add-Label $editor '只修改目前分頁。已連線的iPad不會被中斷；下一次連線使用新碼。' 24 211 418 65
    $apply=Add-Button $editor '驗證並更新' 24 294 200
    $apply.Add_Click({
        try {
            $null=Invoke-RemoteDeskAdmin $Page.Config 'change' @{password=$password.Text;code=$newCode.Text}
            $editor.DialogResult='OK';$editor.Close()
        } catch {$password.Text='';[void][Windows.Forms.MessageBox]::Show($editor,$_.Exception.Message,'更新失敗')}
    })
    $result=$editor.ShowDialog($form);$password.Text='';$newCode.Text='';$editor.Dispose()
    if($result -eq 'OK'){Update-Page $Page;$Page.Detail.Text='配對碼已更新；管理密碼不會保存在輸入框，下次修改需重新驗證。'}
}
function Refresh-Networks($Page) {
    try {
        $Page.Network.Items.Clear()
        foreach($item in @(Get-RemoteDeskAddresses | Where-Object {$_.Mode -eq $Page.Mode})){$Page.Network.Items.Add($item)|Out-Null}
        if($Page.Network.Items.Count){$Page.Network.SelectedIndex=0;$Page.Config=New-RemoteDeskConfig $PSScriptRoot $Page.Mode $Page.Network.SelectedItem.Address;Update-Page $Page}
        else {$Page.State.Text='未偵測到網路';$Page.Detail.Text=if($Page.Mode -eq 'wan'){'請先開啟Tailscale並連線，再按重新整理。'}else{'請先連上家中Wi-Fi或網路線，再按重新整理。'}}
    } catch {$Page.Detail.Text=$_.Exception.Message}
}
function Update-Page($Page) {
    if(!$Page.Config){return}
    try {
        $state=Get-RemoteDeskState $Page.Config
        $Page.Stop.Enabled=$state.Running -and $state.Manageable
        if($state.Running){
            $Page.PendingAt=$null;$Page.Start.Enabled=$false;$Page.Start.Text='已啟動'
            $Page.State.Text='服務運作中';$Page.Url.Text=$Page.Config.Url;$Page.Code.Text=$state.Code
            $Page.Detail.Text=if($state.Manageable){'服務已啟動，可在iPad連線。停止前請先將iPad斷線；關閉啟動器不會停止服務。'}else{'已沿用運作中的服務，但無法核對管理權限，停止服務暫不可用。'}
        } elseif($Page.PendingAt -and ([DateTime]::UtcNow-$Page.PendingAt).TotalSeconds -lt 20){$Page.State.Text='正在啟動…'}
        else {
            $Page.Start.Enabled=$true;$Page.Start.Text='開始';$Page.State.Text='尚未啟動';$Page.Url.Text='';$Page.Code.Text=''
            if($Page.PendingAt){$Page.Detail.Text='啟動失敗：'+(Read-RemoteDeskLog $Page.Config.Stderr);$Page.PendingAt=$null}
        }
    } catch {$Page.State.Text='需要檢查';$Page.Detail.Text=$_.Exception.Message;$Page.Start.Enabled=$true}
}
$reserved=New-Object Windows.Forms.TabPage
$reserved.Text='跨網路 PC（預留）';$reserved.BackColor=[Drawing.Color]::White;$tabs.TabPages.Add($reserved)
$future=Add-Label $reserved '跨網路 PC 對 PC' 36 54 720 55
$future.Font=New-Object Drawing.Font('Microsoft JhengHei UI',22,[Drawing.FontStyle]::Bold)
$null=Add-Label $reserved '此分頁預留給下一階段，目前先完成iPad使用。' 40 130 760 48
$futureButton=Add-Button $reserved '尚未開放' 40 202 220;$futureButton.Enabled=$false
foreach($page in $script:pages){Refresh-Networks $page}
$timer=New-Object Windows.Forms.Timer
$timer.Interval=3000
$timer.Add_Tick({foreach($page in $script:pages){Update-Page $page}})
$form.Add_FormClosed({$timer.Stop();$timer.Dispose()})
if($Preview){
    $form.CreateControl();$form.Show();$form.Refresh()
    if($ValidateServiceButtons){
        $script:OriginalConfigFactory=${function:New-RemoteDeskConfig}
        function New-RemoteDeskConfig($Root,$Mode,$HostAddress){
            $isolated=& $script:OriginalConfigFactory $Root $Mode $HostAddress 19561 19562
            $isolated.Metadata=Join-Path $Root 'bridge\private\launcher-buttons.json'
            $isolated.Stdout=Join-Path $Root 'bridge\private\launcher-buttons.stdout.log'
            $isolated.Stderr=Join-Path $Root 'bridge\private\launcher-buttons.stderr.log'
            return $isolated
        }
        $testPage=$script:pages[0]
        $testPage.Config=New-RemoteDeskConfig $PSScriptRoot 'lan' $testPage.Network.SelectedItem.Address
        if((Get-RemoteDeskState $testPage.Config).Running){throw 'Isolated button test port occupied'}
        try {
            Update-Page $testPage
            $testPage.Start.PerformClick()
            $deadline=[DateTime]::UtcNow.AddSeconds(20)
            do {Start-Sleep -Milliseconds 200;Update-Page $testPage} while(!$testPage.Stop.Enabled -and [DateTime]::UtcNow -lt $deadline)
            if(!$testPage.Stop.Enabled -or $testPage.Start.Enabled){throw "Start button failed: $($testPage.Detail.Text)"}
            $testPage.Stop.PerformClick()
            if((Get-RemoteDeskState $testPage.Config).Running -or !$testPage.Start.Enabled -or $testPage.Stop.Enabled){throw 'Stop button failed'}
            Write-Output 'Real isolated GUI Start -> running -> Stop -> stopped passed.'
        } finally {
            if((Get-RemoteDeskState $testPage.Config).Running){Stop-RemoteDeskService $testPage.Config}
            ${function:New-RemoteDeskConfig}=$script:OriginalConfigFactory
        }
    }
    if($ValidatePasswordFlow){
        $script:setupChecked=$false;$script:changeChecked=$false
        function Invoke-RemoteDeskAdmin($Config,$Action,$InputData=@{}) {
            if($Action -eq 'status'){return [pscustomobject]@{configured=$false}}
            if($InputData.password -ne 'LauncherTest123'){throw 'Unexpected test password'}
            if($Action -eq 'setup'){$script:setupChecked=$true;return [pscustomobject]@{configured=$true}}
            if($Action -eq 'change' -and $InputData.code -eq '11223344'){$script:changeChecked=$true;return [pscustomobject]@{code='11223344'}}
            throw 'Unexpected test operation'
        }
        $dialogTimer=New-Object Windows.Forms.Timer;$dialogTimer.Interval=100
        $dialogTimer.Add_Tick({
            foreach($dialog in @([Windows.Forms.Application]::OpenForms)){
                if($dialog.Text -notin @('首次設定管理密碼','驗證管理密碼並修改配對碼')){continue}
                $fields=@($dialog.Controls | Where-Object {$_ -is [Windows.Forms.TextBox]})
                if($fields.Count -ne 2 -or $fields[0].PasswordChar -ne '*'){throw 'Password dialog must start masked'}
                $eye=@($dialog.Controls | Where-Object {$_ -is [Windows.Forms.Button] -and $_.Text -eq '👁'})[0]
                $eye.PerformClick();if($fields[0].PasswordChar -ne [char]0){throw 'Reveal failed'}
                $eye.PerformClick();if($fields[0].PasswordChar -ne '*'){throw 'Hide failed'}
                $fields[0].Text='LauncherTest123'
                if($dialog.Text -eq '首次設定管理密碼'){$fields[1].Text='LauncherTest123';$caption='設定管理密碼'}else{$fields[1].Text='11223344';$caption='驗證並更新'}
                @($dialog.Controls | Where-Object {$_ -is [Windows.Forms.Button] -and $_.Text -eq $caption})[0].PerformClick()
            }
        })
        $dialogTimer.Start();Show-PairingEditor $script:pages[1];$dialogTimer.Stop();$dialogTimer.Dispose()
        if(!$script:setupChecked -or !$script:changeChecked){throw 'Password flow was not exercised'}
        Write-Output 'First-time setup, masked fields, eye toggle and password-per-change dialog passed (mock backend).'
    }
    if($ValidateLive){
        foreach($page in $script:pages){
            $tabs.SelectedIndex=if($page.Mode -eq 'lan'){0}else{1}
            $page.Start.PerformClick()
            if($page.State.Text -ne '服務運作中' -or $page.Code.Text -notmatch '^\d{8}$'){throw "GUI start failed: $($page.Detail.Text)"}
            if($page.Start.Enabled -or $page.Start.Text -ne '已啟動' -or !$page.Stop.Enabled){throw 'Running service buttons have incorrect states'}
        }
        if($tabs.TabPages.Count -ne 3 -or $futureButton.Enabled){throw 'Reserved PC tab must stay inactive'}
        Write-Output 'GUI Start buttons, existing-service reuse and reserved tab passed.'
    }
    $tabs.SelectedIndex=$PreviewTab;$form.Refresh()
    if($PreviewPath){$bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height);$form.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)));$bitmap.Save($PreviewPath);$bitmap.Dispose()}
    $form.Close();$form.Dispose()
} else {$timer.Start();[void]$form.ShowDialog();$form.Dispose()}
