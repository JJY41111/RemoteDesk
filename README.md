# RemoteDesk

> 2026-09-29 更新：針對 iPad 遊戲 FPS 下滑與文字模糊，新增主機 GPU 轉色、效能數據及可選原生 2560×1440 畫質。主機本機測試通過，iPad 遊戲／字體實測仍待新版驗收。詳見 [`docs/performance-quality-2026-09-29.md`](docs/performance-quality-2026-09-29.md)。

> iPad／筆電瀏覽器接收、配對、遠端輸入與實驗音訊的啟動方式及驗證限制，
> 請先看 [`docs/ipad-bridge-2026-09-18.md`](docs/ipad-bridge-2026-09-18.md)。
> iPad Air 6 已能連線並進行日常瀏覽、鍵盤及滑鼠操作，但畫質、遊戲流暢度、
> 工作列已能顯示、音訊已能播放；音訊斷續、畫質及遊戲流暢度仍在重測。
> 目前不能宣稱已達穩定跨設備 60 FPS。
> 2026-09-23 的 iPad Air 6（M2）操作與驗證清單見
> [`docs/ipad-air6-validation-2026-09-23.md`](docs/ipad-air6-validation-2026-09-23.md)。
> 原生 iPad App 實驗版及無 Mac 試開方式見 [`ipad/README.md`](ipad/README.md)。

Windows 低延遲遠端桌面原型。目前使用 C++、Direct3D 11 與 DXGI Desktop
Duplication API 擷取主要螢幕，並能透過 Windows Media Foundation 將畫面編碼成
H.264 MP4，或在記憶體中完成 H.264 編碼、排隊與解碼 Loopback。
目前也能透過 TCP 將 H.264 畫面送到獨立接收視窗解碼顯示；預設只在
同一台電腦上連線，可明確指定私人區網 IPv4 位址試跑跨設備接收。

## 現階段功能

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
身分驗證。虛擬延伸螢幕尚未實作，網際網路穿透與檔案傳輸也未加入。

先依 [`docs/ipad-air6-validation-2026-09-23.md`](docs/ipad-air6-validation-2026-09-23.md)
測試實機連線，再根據 CSV 與操作結果處理畫質、卡頓及輸入問題。
