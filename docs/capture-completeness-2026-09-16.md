# 畫面完整性修正與驗證（2026-09-16）

## 修正內容

- DXGI Desktop Duplication 的桌面影像未必包含硬體游標。現在依據
  `DXGI_OUTDUPL_FRAME_INFO` 的游標可見狀態與位置，在共用的
  `latestFrameTexture` 上繪製游標，再提供給預覽、錄影和 Loopback。
- Windows 拖曳 RemoteDesk 自己的視窗時會進入移動視窗的內部訊息迴圈，
  使原本的主迴圈暫停。現在在 `WM_ENTERSIZEMOVE` 啟動 16 ms 計時器，
  由 `WM_TIMER` 持續擷取，並於 `WM_EXITSIZEMOVE` 停止。

## 已完成的自動驗證

- `build.bat`：成功，無專案程式碼編譯警告。
- `out\remote_desk.exe --record-test`：五秒、150 幀，程式日誌記錄
  `pointer_draws=826`，沒有游標繪製或 GDI／DXGI 錯誤。
- `out\remote_desk.exe --loopback-test`：提交、編碼、解碼各 150 幀，
  `image=yes`，沒有錯誤。

游標繪製次數表示繪製呼叫成功，還不能代替逐幀的視覺檢查。

## 手動驗收

使用者於 2026-09-16 回報「已驗證」。目前沒有另存手動拖曳的逐幀影片分析
或測試紀錄，因此下列步驟保留供之後回歸測試。

1. 執行 `out\remote_desk.exe`，確認預覽視窗和錄影中的游標位置、形狀正確。
2. 按 `R` 開始錄影，拖曳 **RemoteDesk 視窗本身** 數秒，再按 `R` 停止。
3. 檢查 `capture.mp4` 是否顯示拖曳的中間位置；檢查 `runtime.log`
   是否記錄 `capture: move timer processed N frames` 且 `N > 0`。
4. 若原問題是拖曳其他應用程式視窗，也要分開重測；此計時器修正針對
   RemoteDesk 自己的視窗。

## 限制

- 目前以 DXGI metadata 判斷游標位置和可見性，形狀使用當下的 Win32
  游標圖示；尚未直接解析 `GetFramePointerShape` 的色彩／遮罩資料。
  特殊游標、動畫游標、螢幕旋轉或多螢幕仍可能有時間差或位置差。
- GDI 游標合成可能增加 GPU／CPU 同步成本；尚未完成長時間與 60 fps
  穩定性測試。
- 若系統設定為拖曳時只顯示視窗外框，桌面影像本身就沒有中途移動的
  完整視窗內容，計時器無法憑空產生那些畫面。
