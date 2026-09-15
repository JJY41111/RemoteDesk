# H.264 記憶體 Loopback 驗證紀錄 — 2026-09-16

## 目的

確認桌面畫面不需要先寫入 MP4，也能完成下列即時資料流程：

```text
DXGI BGRA Texture
  → CPU 縮放與 BGRA 轉 NV12
  → Microsoft H.264 Encoder MFT
  → 記憶體封包佇列
  → Microsoft H.264 Decoder MFT
  → NV12 解碼畫面驗證
```

這是未來將記憶體 H.264 封包交給網路傳輸層之前的本機驗證。

## 建置與測試

- 建置指令：`build.bat`
- 測試指令：`out\remote_desk.exe --loopback-test`
- 測試時間：約 5 秒
- 程序結束代碼：`0`
- Loopback 解析度：1280×720
- 目標幀率：30 fps
- H.264 Profile：Main
- 要求的目標位元率：4 Mbps

## 實測結果

- 提交至編碼器：150 幀
- 成功編碼：150 幀
- 成功解碼：150 幀
- H.264 封包總量：1,673,337 位元組
- 約略平均位元率：2.68 Mbps
- 平均 BGRA→NV12 轉換時間：14.44 ms
- 平均 H.264 編碼時間：1.32 ms
- 平均記憶體佇列等待時間：0.08 ms
- 平均 H.264 解碼時間：0.58 ms
- 解碼影像內容檢查：通過

本次短測試中，提交、編碼與解碼幀數一致，沒有觀察到編解碼階段掉幀。

## 測試期間修正的問題

第一次啟動 MFT 時，在尚未開始串流前送出
`MFT_MESSAGE_COMMAND_FLUSH`，Microsoft H.264 MFT 回傳 `0x80004005`。

Flush 用於清除既有串流的狀態，不是全新 MFT 的必要初始化步驟。移除該呼叫，
保留 `MFT_MESSAGE_NOTIFY_BEGIN_STREAMING` 與
`MFT_MESSAGE_NOTIFY_START_OF_STREAM` 後，五秒 Loopback 測試成功完成。

## 既有功能回歸測試

加入 Loopback 後，重新執行 `--record-test`：

- 程序結束代碼：`0`
- H.264 MP4 編碼幀數：150
- 輸出檔案大小：5,246,623 位元組

原有 MP4 錄影功能仍可正常完成。

## 目前限制

- BGRA→NV12 使用單執行緒 CPU 轉換與最近鄰縮放，是目前最大的已知耗時。
- 這裡量到的是 Codec Pipeline 耗時，不包含網路、Client 顯示及 Glass-to-glass
  延遲，不能直接稱為遠端操作延遲。
- 記憶體佇列目前在同一執行緒立即消費，尚未模擬網路抖動、封包遺失或壅塞。
- 解碼結果已做內容檢查，但主視窗仍顯示擷取端原始畫面；尚未建立獨立 Client
  解碼預覽視窗。
- 本次只有五秒短測試，不代表長時間穩定性。
