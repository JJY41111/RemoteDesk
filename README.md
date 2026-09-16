# RemoteDesk

Windows 低延遲遠端桌面原型。目前使用 C++、Direct3D 11 與 DXGI Desktop
Duplication API 擷取主要螢幕，並能透過 Windows Media Foundation 將畫面編碼成
H.264 MP4，或在記憶體中完成 H.264 編碼、排隊與解碼 Loopback。
目前也能在同一台電腦上透過 TCP 將 H.264 畫面送到獨立接收視窗解碼顯示。

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
命令後加上 `--test`。兩個程序只透過 `127.0.0.1:5000` 連線。驗證數據詳見
[`docs/network-validation-2026-09-16.md`](docs/network-validation-2026-09-16.md)。
接收端已啟用 H.264 解碼器的低延遲模式，並在 `receiver.log` 記錄同機
「封包排入傳送佇列至接收視窗完成 CPU 繪製」的延遲；實測與量測限制見
[`docs/latency-validation-2026-09-16.md`](docs/latency-validation-2026-09-16.md)。

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

## 暫不處理

- 網際網路連線與 NAT 穿透
- 遠端鍵盤與滑鼠控制
- 跨電腦的區域網路傳輸與連線驗證、加密
- 虛擬延伸螢幕
- 音訊、檔案傳輸與手把

這些功能會在本機擷取與編解碼管線穩定後再逐步加入。
