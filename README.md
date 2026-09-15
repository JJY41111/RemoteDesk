# RemoteDesk

Windows 低延遲遠端桌面原型。目前的第一個里程碑是使用 C++、Direct3D 11 與
DXGI Desktop Duplication API 擷取主要螢幕，並在本機視窗即時預覽與量測效能。

## 現階段功能

- 擷取主要顯示卡的第一個輸出螢幕
- 在本機視窗即時預覽桌面
- 每秒在標題列顯示實際 FPS、平均擷取時間、逾時次數與解析度
- 按 `Esc` 關閉程式

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

## 暫不處理

- 網際網路連線與 NAT 穿透
- 遠端鍵盤與滑鼠控制
- 虛擬延伸螢幕
- 音訊、檔案傳輸與手把

這些功能會在本機擷取與編解碼管線穩定後再逐步加入。
