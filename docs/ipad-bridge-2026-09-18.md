# iPad／筆電瀏覽器接收準備 — 2026-09-18

## 現在能做什麼

`bridge/` 是獨立放在 RemoteDesk 專案內的 Node.js WebRTC 橋接程式。它從本機
`127.0.0.1:5000` 接收既有 C++ 程式產生的 H.264，封裝成 WebRTC 視訊，
由 iPad Safari 或筆電瀏覽器顯示。瀏覽器頁面會統計實際呈現幀率、最近一秒
最大畫面間隔、送出與丟棄幀數。橋接服務可自行啟動 C++ 擷取程式。

橋接服務使用 HTTPS 和 WebRTC 加密。每次啟動印出新的八位數配對碼，最多
同時接受一個接收端；連錯五次會暫停一分鐘。原始 H.264 TCP 只在這台
Windows 主機的 `127.0.0.1:5000` 連線，不開放到區網。配對碼只能交給
你信任的裝置。服務只綁定明確指定的私人 IPv4，不提供網際網路穿透。

遠端輸入須在主機端加 `--enable-input`，接收頁也須勾選「啟用本次遠端操作」。
觸控、滑鼠、實體鍵盤與文字輸入會轉成 Windows 輸入；手把目前映射成鍵盤
按鍵，方向對應方向鍵，主要按鍵對應 Z／X／C／V／A／S。要玩遊戲需在遊戲
裡把鍵盤按鍵設成相應操作；這不是 XInput 虛擬手把。停止控制或斷線會釋放
已按下的鍵與滑鼠按鈕。Windows 權限較高的視窗可能不接受一般權限程序
送入的輸入。

2026-09-23 補強：控制勾選狀態也在主機端檢查；未啟用時忽略輸入，停用時
主機釋放已按住的鍵與滑鼠按鈕。滑鼠滾輪已加入。瀏覽器頁可下載逐秒
FPS、最長畫面間隔、丟幀及解析度 CSV。這些變更尚待 iPad 實機操作驗收。

`--audio` 會擷取 Windows 預設播放裝置的聲音，以 Opus 經 WebRTC 傳給瀏覽器。
接收頁要點「播放聲音」；未測量影音同步與主觀音質。`--display=0:0` 可選取
要擷取的 DXGI 顯示卡／輸出，遠端滑鼠位置會依該輸出的桌面座標換算。
這是選擇已有螢幕的功能，**不會建立虛擬延伸螢幕**。

## Windows 主機啟動

在 `C:\Users\johnl\Desktop\RemoteDesk`：

```powershell
.\build.bat
.\out\remote_desk_input.exe --list-displays
cd bridge
npm.cmd ci
npm.cmd run preflight
npm.cmd start -- --host=192.168.0.95 --enable-input --audio --display=0:0
```

把示範 IP 換成 Windows 主機當下的私人區網 IP。若先求穩定、減少畫質負擔，
可在最後一行再加 `--720p`。不要同時執行舊的 `remote_desk_receiver.exe`，
因為橋接服務會占用本機 `127.0.0.1:5000`。第一次啟動可能出現 Windows
防火牆提示，須由使用者選擇是否允許這個 Node 程式在私人網路被連線。

服務會印出接收網址、八位配對碼、CA 憑證下載網址及 CA 的 SHA-256 指紋。
`bridge/private/` 的私鑰不會進 Git；**不要把 `ca-key.pem` 或 `key.pem` 分享
給其他設備，也不要把本機 CA 安裝到不信任的設備**。

## iPad Air 6（M2）測試

1. 讓 iPad 與 Windows 主機加入可互通的私人區網。iPad Safari 打開主機印出的
   `http://<主機 IP>:8442/ca.crt`，下載 RemoteDesk Local Root CA；確認它的
   SHA-256 指紋與 Windows 終端顯示相同再信任。下載網址只提供公開憑證，
   不提供私鑰。
2. 到 iPad「設定 → 一般 → VPN 與裝置管理」安裝下載的憑證。再到
   「設定 → 一般 → 關於本機 → 憑證信任設定」，對 RemoteDesk Local Root CA
   開啟完整信任。Apple 說明：[安裝設定描述檔](https://support.apple.com/en-ca/guide/ipad/ipad03886972/ipados)、
   [手動信任憑證](https://support.apple.com/en-ie/102390)。
3. Safari 開啟主機印出的 `https://<主機 IP>:8443`，輸入主機終端顯示的
   八位配對碼；點「播放畫面」。若啟用聲音，再點「播放聲音」。
4. 在接收頁觀察呈現 FPS 與最長畫面間隔。測試視窗拖曳、快速移動畫面後，
   才勾選遠端操作，測觸控／鍵盤／手把；切回主機畫面可即時結束程式。

## 已驗證與尚未驗證

2026-09-18：`build.bat` 完成，C++ 程式碼無警告；協定單元測試通過。
同一台 Windows 電腦的 Chrome 自動測試完成配對、WebRTC 連線、實際
H.264 接收與解碼：720p60 一次短測約 59～60 呈現 FPS、約 87～94 個
已解碼畫面；1080p60 一次短測約 55～60 呈現 FPS、約 87～96 個已解碼
畫面。開啟實驗音訊時，瀏覽器收到 61 個 Opus RTP 封包。這些是短時間
本機瀏覽器測試，**沒有用 iPad、第二台筆電或真正跨設備網路驗證**。

尚待：iPad Safari 對配對、憑證、1080p60 H.264 的實機相容性；兩台設備
間的連線穩定度、快速動態畫質、長時間掉幀、輸入到畫面的延遲、聲音是否
正常聽到、手把在 iPad 上的瀏覽器支援。FPS 是瀏覽器呈現回呼估計值，
不等於面板實際掃描或遊戲按鍵到畫面的延遲。

虛擬延伸螢幕的後續工作需要 Windows 間接顯示驅動（IddCx）。微軟
[IddSample](https://learn.microsoft.com/en-us/samples/microsoft/windows-driver-samples/indirect-display-driver-sample/)
只示範枚舉螢幕與接收畫面，未準備成安全可安裝的產品驅動；此專案目前沒有
建立、簽署或安裝該驅動。先以 `--list-displays`／`--display` 驗證現有第二
顯示器來源，再決定驅動方案。

## 2026-09-25 手把路徑更新

先前「手把映射成鍵盤」的說明只適用於舊版。現在網頁將標準 Gamepad API
的按鈕、類比扳機與雙搖桿獨立送到主機；鍵盤仍走原本的鍵盤路徑。
主機可選用 `--gamepad=viiper`，透過本機 `127.0.0.1:3242` 的 VIIPER API
建立虛擬 Xbox 360 控制器。仍須加 `--enable-input`，網頁也須勾選
「啟用本次遠端操作」。停用、斷線或逾 500 毫秒沒有新手把資料時，
主機會送出歸零狀態。沒有啟用 `--gamepad=viiper` 時，手把不再變成鍵盤鍵。

2026-09-25 已安裝 VIIPER 所需的 Windows USBIP 驅動；本機 XInput
讀到虛擬 Xbox 360 手把及 A 鍵。iPad 到遊戲的完整路徑尚待實測。
版本、雜湊、簽章及根憑證比對見
[`gamepad-install-2026-09-25.md`](gamepad-install-2026-09-25.md)。
這個 Windows USBIP 驅動和 iPad 已信任的 RemoteDesk HTTPS CA
是兩件不同的事。

2026-09-25 補上遠端 Windows 鍵：Safari 若能提供 `MetaLeft`／`MetaRight`
按鍵事件，橋接會送出相應的 Windows 鍵；頁面另外提供「遠端 Win」
與「按住 Win」按鈕，供 iPad 攔下實體系統鍵時操作開始功能表或
Win+R 等組合鍵。按住狀態會在停止控制或失去頁面焦點時釋放。
