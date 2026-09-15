# RemoteDesk

Windows 低延遲遠端桌面原型。目前使用 C++、Direct3D 11 與 DXGI Desktop
Duplication API 擷取主要螢幕，並能透過 Windows Media Foundation 將畫面編碼成
H.264 MP4。

## 現階段功能

- 擷取主要顯示卡的第一個輸出螢幕
- 在本機視窗即時預覽桌面
- 每秒在標題列顯示實際 FPS、平均擷取時間、逾時次數與解析度
- 按 `R` 開始／停止錄製 `capture.mp4`（H.264、30 fps、8 Mbps）
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

## 暫不處理

- 網際網路連線與 NAT 穿透
- 遠端鍵盤與滑鼠控制
- 虛擬延伸螢幕
- 音訊、檔案傳輸與手把

這些功能會在本機擷取與編解碼管線穩定後再逐步加入。
