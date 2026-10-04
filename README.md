# RemoteDesk

## 專案介紹

RemoteDesk 是開發中的 Windows 遠端桌面原型，可在同一個私人區網或經 Tailscale
連接的私人網路，從 iPad 瀏覽器觀看並操作 Windows 電腦。Windows 主機以 C++、Direct3D 11
和 DXGI Desktop Duplication 擷取畫面，再透過 Media Foundation 編碼為 H.264；
Node.js 橋接程式提供 HTTPS 配對與 WebRTC 串流。

目前支援畫面、鍵盤與滑鼠回傳、系統音訊，以及可選的虛擬 Xbox 手把路徑。
接收頁可選 1080p 遊戲優先或原生 2560×1440 文字優先模式，並下載逐秒統計
CSV。專案另保留本機錄影、編解碼 Loopback 和獨立 Windows TCP 接收程式，
供擷取與傳輸測試。iPad 以「加入主畫面」網頁版為主要接收方式；虛擬延伸螢幕尚未完成。

配對後的「功能」選單另有剪貼簿與檔案傳輸：iPad 可貼上文字／圖片，按送出後在
Windows 使用 Ctrl+V；也可上傳文件、程式碼、壓縮檔、照片與影片，存到主機桌面的
`ipad傳輸` 資料夾。檔案不限副檔名，單檔上限 4 GiB；同名檔案會另存新名稱。
傳輸只對目前已配對的工作階段開放，斷線後權杖失效。iPad 實機的圖片貼上及大檔
傳輸仍待驗收，詳見 [`傳輸功能與遊戲紀錄`](docs/ipad-transfer-2026-10-02.md)。

此專案仍在調整跨地區連線與遊戲延遲。Tailscale 路徑已在 iPad Safari／主畫面
網頁 App 進行跨地區實測；日常使用已有可用回報，遊戲反應仍待改善。使用方式見
[`跨地區 iPad 連線`](docs/cross-region-2026-10-01.md) 與
[`iPad／瀏覽器接收說明`](docs/ipad-bridge-2026-09-18.md) 與
[`加入主畫面使用說明`](ipad/README.md)；主要測試報告連結列於本文後段。

## 最新版本與快速使用

目前接收端／主機版本為 **2026-10-04.5**，以 iPad「加入主畫面」PWA 為主要使用方式。

- **PC 啟動器**：雙擊 `RemoteDesk-Launcher.vbs`，可開始／停止同網路或 Tailscale 跨網路服務；PC 對 PC 分頁僅預留。
- **配對管理**：啟動器可自訂8位配對碼，每次修改需輸入管理密碼；密碼與配對碼預設遮蔽，可按眼睛顯示。自訂碼重啟後保留，未自訂則隨機產生。管理密碼採雜湊保存；這不是獨立因素的雙因素驗證。
- **遠端功能**：鍵鼠、右 Shift、Xbox 手把、音訊、文字／圖片剪貼簿、各類檔案傳輸、150% 檢視與頂端工具列。
- **跨區遊戲修正**：手把最新狀態短時間補送、停畫時主動要求恢復影格，並輸出通道往返與前後端版本。游標邊界仍限制 iPad 網頁的第一人稱滑鼠操作。
- **接收緩衝**：偵測 `jitterBufferTarget` 支援，可選80／120／160 ms基準；不代表總延遲或保證值，原緩衝已低時不刻意增加。異常時嘗試還原瀏覽器預設。

首次仍需 Windows C++ 建置、Node.js 套件與 HTTPS 憑證設定；跨網路需兩端 Tailscale，虛擬手把需另行設定 VIIPER／相容驅動。啟動器不自動安装驅動。

操作指南：[`PC啟動器`](docs/pc-launcher-2026-10-04.md)、[`配對碼管理`](docs/launcher-pairing-password-2026-10-04.md)、[`加入主畫面`](ipad/README.md)。

近期驗證：39項Node測試、Windows隔離串流與VIIPER測試已通過。日常使用已有iPad實機回報；遊戲仍有網路突發失包及間歇卡頓，不承諾持續55–60 FPS或低輸入延遲。詳見[`最新實機紀錄與版本核對`](docs/client-version-2026-10-04.md)、[`停畫與手把修正`](docs/game-input-loss-2026-10-04.md)、[`接收緩衝測試`](docs/safari27-buffer-2026-10-04.md)。

原生App路線已取消；GitHub不提供個人的憑證／私鑰、管理密碼或已取消的App安裝包。請使用每台主機自己的網址與配對碼，歷史文件中的IP不代表你的主機設定。

## Windows 擷取程式功能

- 擷取主要顯示卡的第一個輸出螢幕
- 在本機視窗即時預覽桌面
- 將獨立顯示的滑鼠游標合成到預覽、錄影與 Loopback 共用畫面
- 拖曳 RemoteDesk 自己的視窗時，透過計時器繼續擷取
- 每秒在標題列顯示實際 FPS、平均擷取時間、逾時次數與解析度
- 按 `R` 開始／停止錄製 `capture.mp4`（H.264、30 fps、8 Mbps）
- 按 `L` 開始／停止 1280×720、30 fps 的記憶體 H.264 Loopback
- 按 `Esc` 關閉程式

> Media Foundation 已設定允許硬體轉換，但目前尚未識別實際被選用的編碼器，
> 因此不能宣稱一定使用 NVENC 或其他特定硬體編碼器。

## 建置需求

- Windows 10 或 Windows 11
- Visual Studio（Desktop development with C++）
- CMake 3.20 以上

## 建置與執行

最快的方式是在一般命令提示字元或 PowerShell 執行：

```powershell
.\build.bat
.\out\remote_desk.exe
```

若要自動錄製五秒並在完成後結束程式：

```powershell
.\out\remote_desk.exe --record-test
```

若要自動執行五秒記憶體編解碼 Loopback：

```powershell
.\out\remote_desk.exe --loopback-test
```

若要觀看獨立程序間的 H.264 TCP 畫面，先在一個終端執行：

```powershell
.\out\remote_desk_receiver.exe
```

再在另一個終端執行：

```powershell
.\out\remote_desk.exe --network-test
```

接收視窗會顯示 1280×720、30 fps 的解碼畫面。傳送測試五秒後結束；
接收視窗保留最後一幀，可按 `Esc` 關閉。若要測完自動關閉，可在接收端
命令後加上 `--test`。不指定區網位址時，兩個程序只透過 `127.0.0.1:5000`
連線。驗證數據詳見
[`docs/network-validation-2026-09-16.md`](docs/network-validation-2026-09-16.md)。
若要比較 720p60，把傳送端命令換成 `--network-60-test`；接收端會自動辨識
30／60 fps。若 720p60 的文字或細節太糊，可用 `--network-1080-60-test`
測試 1920×1080、60 fps；接收視窗會依解析度調整大小。兩個執行檔須由
同一次 `build.bat` 建置。若一開始停在
`waiting`，傳送端會在 DXGI 尚未產生更新畫面時，用一次 GDI 桌面快照
建立初始影格；若仍未連上，請查看兩端日誌及 Windows 防火牆提示。
可在傳送端測試模式加 `--duration=30`，進行 1–300 秒的定時測試；
接收端加 `--test` 可在串流結束後自動關閉。
接收端已啟用 H.264 解碼器的低延遲模式，並在 `receiver.log` 記錄同機
「封包排入傳送佇列至接收視窗完成 CPU 繪製」的延遲；實測與量測限制見
[`docs/latency-validation-2026-09-16.md`](docs/latency-validation-2026-09-16.md)。
接收端現在也把每個封包宣告為一張完整 H.264 畫面，避免解碼器為等待
下一個可能的片段而多緩衝一幀；2026-09-17 的實測結果見
[`docs/game-latency-baseline-2026-09-17.md`](docs/game-latency-baseline-2026-09-17.md)。

若要親自觀察拖曳視窗時的延遲，先開接收端，再執行不會在五秒後自動結束的
持續模式：

```powershell
.\out\remote_desk_receiver.exe
.\out\remote_desk.exe --network-live
```

720p60 持續模式使用 `--network-60-live`；1080p60 持續模式使用
`--network-1080-60-live`。請先用 30 fps 和 60 fps 各拖曳
同一個一般視窗，觀察接收視窗；接收視窗標題及 `receiver.log` 會顯示延遲，
接收視窗標題現在也顯示最近約一秒的實際繪製 FPS、未畫出的影格數與
最長畫面間隔；`receiver.log` 記錄整段實際接收／繪製 fps 及這些卡頓指標。
`build.bat` 目前以 `/O2` 最佳化
兩個執行檔；沒有這項最佳化時，60 fps 測試曾因 CPU 像素轉換跟不上而
累積超過一秒延遲。最新對照數據見
[`docs/game-latency-baseline-2026-09-17.md`](docs/game-latency-baseline-2026-09-17.md)。

兩行請在**不同終端**執行。拖曳其他桌面視窗觀察接收端；按傳送端視窗的
`Esc` 結束串流，接收視窗保留最後畫面，再按它的 `Esc` 關閉。
接收視窗標題每約 30 幀更新最近最多 60 幀的封包至繪製 P95。
傳送端標題的 FPS 只是擷取端數字；驗收遠端畫面時應看接收端，且目前
的「繪製 FPS」仍不等於實體螢幕確實顯示的刷新率。
1080p60 在一次同機五秒測試中接收並繪製 300 幀，約 60.4 繪製 FPS；
指定同機區網 IP 的 30 秒靜態桌面測試繪製 1,800 幀、約 60.01 FPS，
未跳過影格。另一輪較忙的桌面試跑只有約 55 FPS，尚未證明動態場景
能穩定 60。跨設備連線、長時間穩定性及遊戲動態畫質也尚未驗證。詳見
[`docs/quality-1080p60-validation-2026-09-18.md`](docs/quality-1080p60-validation-2026-09-18.md)。
網路模式會嘗試將傳送端預覽及接收視窗排除於桌面擷取，避免本機測試時
「鏡中鏡」反覆編碼；被排除的視窗不會出現在接收畫面中。
接收視窗也會顯示同機「桌面更新至繪製」的近期 P95；測試方式、結果與
遊戲用途的剩餘瓶頸見
[`docs/game-latency-baseline-2026-09-17.md`](docs/game-latency-baseline-2026-09-17.md)。

## 區網接收試跑（未完成安全與跨設備驗收）

接收設備先查自己的私人區網 IPv4 位址，假設為 `192.168.1.50`。在接收
設備執行：

```powershell
.\out\remote_desk_receiver.exe --listen=192.168.1.50
```

在**要被擷取的電腦**執行：

```powershell
.\out\remote_desk.exe --network-1080-60-live --connect=192.168.1.50
```

兩台電腦須在彼此可達的可信任私人區網中，並使用同次建置的程式；程式
只接受回環或 RFC 1918 私人 IPv4，不會自動建立防火牆規則。若 Windows
詢問是否開放接收端的網路存取，需由使用者自行判斷。**目前沒有身分
驗證或加密，畫面會以未加密的 H.264/TCP 傳輸；請勿在不可信網路傳送
敏感畫面，也不要做路由器連接埠轉送。**

跨電腦時，接收端標題和 `receiver.log` 只提供接收後到繪製的延遲、
實際繪製 FPS、跳幀和最長間隔；兩台電腦的高解析度計時器不能直接相減，
因此不會顯示假的「桌面變化到接收」延遲。實際第二台設備尚未測試，
本機指定區網 IP 的試跑與剩餘問題見
[`docs/lan-experimental-2026-09-18.md`](docs/lan-experimental-2026-09-18.md)。

要重跑 30 秒、有完整接收日誌的定時測試，可把兩端命令改為：

```powershell
.\out\remote_desk_receiver.exe --listen=192.168.1.50 --test
.\out\remote_desk.exe --network-1080-60-test --connect=192.168.1.50 --duration=30
```

也可以在 Developer PowerShell for Visual Studio 中使用 CMake：

```powershell
cmake -S . -B build
cmake --build build --config Release
.\build\Release\remote_desk.exe
```

若 `cmake` 沒有加入 PATH，可改用 Visual Studio 內建的 CMake。

## 第一階段驗收標準

- 在 1920x1080 螢幕上以接近 60 fps 擷取與預覽
- 連續執行 10 分鐘不崩潰
- 記憶體使用量不持續上升
- 留下 FPS、平均擷取時間與逾時次數的實測紀錄

## 第二階段驗收標準

- 按 `R` 後能產生可播放的 `capture.mp4`
- 影片格式為 H.264，解析度符合擷取螢幕
- 錄製期間顯示已編碼幀數
- 實測錄製 FPS、CPU／GPU 使用率與輸出位元率

2026-09-16 已完成一次五秒自動測試：2560x1440、30 fps、150 幀，並確認
H.264 影片不是全黑畫面。詳細證據與限制見
[`docs/validation-2026-09-16.md`](docs/validation-2026-09-16.md)。

## 第三階段：本機即時編解碼 Loopback

- 將桌面 BGRA 畫面縮放並轉換成 1280×720 NV12
- 透過 Microsoft H.264 Encoder MFT 產生記憶體封包
- 封包經由本機佇列送入 Microsoft H.264 Decoder MFT
- 統計色彩轉換、編碼、排隊與解碼時間
- 檢查解碼後的 NV12 畫面是否包含有效影像

2026-09-16 的五秒測試完成 150 次提交、150 次編碼與 150 次解碼。詳細數據
與限制見 [`docs/loopback-validation-2026-09-16.md`](docs/loopback-validation-2026-09-16.md)。

主視窗仍顯示擷取端原始預覽；獨立接收視窗顯示經 TCP 傳送並解碼的畫面。

## 畫面完整性修正

2026-09-16 已加入游標合成與視窗拖曳期間的擷取計時器。五秒自動錄影
仍完成 150 幀，日誌顯示游標繪製 826 次；Loopback 仍完成 150 幀。
實際手動拖曳過程、游標特殊形狀及長時間效能尚待驗收。測試方式與
已知限制見 [`docs/capture-completeness-2026-09-16.md`](docs/capture-completeness-2026-09-16.md)。

## iPad／瀏覽器路線的目前邊界

2026-09-29 新版預設「即時操作」：影音分開播放，避免聲音延遲拖慢畫面；
要唇形同步可在連線前改選「影片觀賞」。按播放才傳送音訊，並支援暫停／
恢復。會令 iPad 凍結的 RTP 視訊播放目標已移除。本機對照實驗確認此
同步策略能降低視訊額外等待，但新版 iPad 仍待驗收。更新方式與證據見
[同步修正與驗證](docs/latency-sync-2026-09-29.md)。

`bridge/` 已有 HTTPS 配對、WebRTC 畫面、可選的遠端鍵盤與滑鼠輸入、
獨立的手把傳輸路徑，以及實驗音訊。網頁可下載逐秒畫面統計 CSV。
iPad Air 6 初次實測可連線，日常瀏覽與鍵鼠操作可用，但文字稍糊、
遊戲體驗勉強，曾出現串流停頓。工作列邊緣修正已由 iPad 確認，音訊已
出聲，9/25 回報音訊明顯改善但偶有雜訊，操作延遲增加，該輪未再卡死。
9/25 長時 iPad CSV 顯示接收緩衝曾達數百毫秒、音訊有丟包；關閉藍牙
播放裝置後音訊 helper 因裝置失效退出。現已加入預設裝置重新擷取、
遠端 F5、鍵盤控制焦點與手把偵測提示。已加入可選 VIIPER 虛擬 Xbox
手把連接器；Windows USBIP 驅動已安裝，本機 XInput 已讀到虛擬手把
與 A 鍵。iPad 到遊戲的完整路徑仍待實測。第二台筆電、長時間動態
場景及實際操作延遲亦未
驗收。瀏覽器橋接會把未加密的原始 H.264 TCP
限制在主機 `127.0.0.1`；上面的直接私人 IP TCP 接收模式仍不具備加密或
身分驗證。虛擬延伸螢幕尚未實作；跨網路目前依賴已連線的 Tailscale，
程式本身未提供公網穿透或檔案傳輸。

先依 [`docs/ipad-air6-validation-2026-09-23.md`](docs/ipad-air6-validation-2026-09-23.md)
測試實機連線，再根據 CSV 與操作結果處理畫質、卡頓及輸入問題。

## 測試結果與開發紀錄

- [2026-09-29：iPad 遊戲 FPS、文字清晰度與 Windows 本機驗證](docs/performance-quality-2026-09-29.md)：已加入 GPU 轉色、主機效能紀錄與可選原生 2560×1440 畫面；新版 iPad 遊戲與文字效果仍待驗收。
- [影音同步修正與驗證](docs/latency-sync-2026-09-29.md)：記錄不同播放策略的本機對照及 iPad 待測項目。
- [iPad Air 6 操作與驗證清單](docs/ipad-air6-validation-2026-09-23.md)：區分已在實機確認的功能與尚待測試的功能。
- [1080p60 畫質與 FPS 測試](docs/quality-1080p60-validation-2026-09-18.md)、[本機遊戲延遲基準](docs/game-latency-baseline-2026-09-17.md)：較早的 Windows 本機測試，不能當作 iPad 遊戲表現。

iPad Air 6 已能連線，日常瀏覽、鍵鼠操作、工作列顯示和聲音播放均有實機回報；
遊戲流暢度、偶發音訊雜訊與細字清晰度仍在調整。2026-09-29 的測試中，
《漫威蜘蛛人 2》在 iPad 約 20–30 FPS，且 150% 檢視放大未解決字糊。
因此目前不能宣稱已達穩定的跨設備 60 FPS 或完成畫質驗收。
