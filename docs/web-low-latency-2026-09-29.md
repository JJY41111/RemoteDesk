# 網頁低延遲模式：2026-09-29

> 本文保留早期實驗與失敗紀錄。現行版本已移除 RTP 視訊播放目標；請依 [最新同步修正版](latency-sync-2026-09-29.md) 使用。

使用者已確認 Safari 恢復連線。本次先完成網頁低延遲功能；原生 App 尚未
成功在 iPad 啟動，沒有足以判斷兩者實際效能的比較數據。

## 功能

- 移除對 Safari 未提供的 `jitterBufferTarget`／`playoutDelayHint` 的依賴。
- 主機在 SDP 提供 `playout-delay` RTP 擴充；只在接收端的有效 video
  answer 接受相同 ID、URI 和接收方向後，才在影像封包啟用此擴充。
- 勾選時設定播放延遲目標 0–50 ms；libdatachannel 使用 10 ms 單位，
  因此實際設定為 min=0、max=5。這是接收器的盡力而為目標，
  **不是整體操作延遲保證，也不包含擷取、編碼、傳輸與螢幕顯示時間**。
- 取消時明確送出 0–10000 ms 的寬鬆範圍，解除先前 50 ms 上限；
  不代表接收器會緩衝十秒。單純停止送擴充會讓接收器保留上一個目標。
- 主機 PCM 積壓上限由 120 ms 降為 60 ms，超過時保留約 40 ms，
  依完整立體聲 sample 對齊裁切。20 ms 音訊節奏與 40 ms 預備量不變。
  此項只減少過量排隊，不能直接推論平時音訊延遲減少 60 ms。
- 網頁等待主機確認才顯示套用，5 秒沒確認就顯示失敗並還原勾選狀態。
  舊版主機會提示重新啟動；若接收端不接受視訊擴充，也會明確顯示。

協定依據：[WebRTC playout-delay RTP extension](https://webrtc.github.io/webrtc-org/experiments/rtp-hdrext/playout-delay/)。

## 本機驗證

- 單元測試 12/12 通過：協商方向、拒絕的媒體、擴充 ID、原生 RTP 設定、
  開關恢復、PCM 對齊與裁切。
- UI 測試通過：模擬沒有接收緩衝 API 的 Safari，確認指令與主機回覆流程。
- `npm.cmd run test:latency` 通過：隔離的 localhost 8544/55444、真實
  HTTPS 配對及 WebRTC、合成 H.264 解碼、主機音訊 RTP、四次模式階段、
  CSV 欄位與斷線重新配對。未停止使用者正在運行的 bridge。
- 四個 3.5 秒觀測階段各解碼 210、222、210、218 幀；開啟階段的 Chrome
  視訊接收緩衝約 31 ms。這是短時間同機合成影像測試，不能代表 Windows
  擷取效能、iPad Safari 表現、聲音聽感或端到端操作延遲。
- 本機結果輸出在 `bridge/test-results/latency-browser.json`，屬忽略檔案。

## 更新及 iPad 驗證

在原本執行 bridge 的視窗按 Ctrl+C，再執行：

```powershell
cd C:\Users\johnl\Desktop\RemoteDesk\bridge
.\start-ipad.cmd
```

不需要重新編譯 C++、安裝 npm 套件或重裝 CA。本次未改憑證。
重新整理 iPad 頁面，使用終端機的新配對碼，播放畫面與音訊，再勾選低延遲。
修正後的 iPad 頁面應看到「此接收端已停用視訊播放目標」及
「主機音訊排隊上限 60 ms」。原版此處預期顯示視訊 0–50 ms 的說明
已被下面的實機診斷推翻。

同一連線與同一場景先關閉 1–2 分鐘，再開啟 1–2 分鐘，保持音訊條件一致；
觀察雙螢幕時間差、卡頓與音訊斷續，結束後下載 CSV。網路抖動時，縮小
緩衝可能增加卡頓；若惡化可即時取消，不必重新連線。

新增 CSV 欄位：`latency_control_version`、`host_low_latency_enabled`、
`video_playout_negotiated`、`video_playout_max_ms`、`audio_queue_limit_ms`。
版本 3 的 `low_latency_applied` 表示至少一項主機控制已套用，
並非量測結果；必須分別看視訊協商、接收緩衝與雙螢幕時間差。

## iPad 實測後修正

使用者的 CSV `remotedesk-metrics-2026-09-28T16-47-10-909Z.csv` 顯示，
16:45:41 UTC 開啟時主機仍每秒送出 60 幀、Safari 仍每秒解碼約 60 幀，
但畫面呈現於下一秒降到 2 幀，隨後連續多秒為 0。16:46:00 UTC 取消後
立即恢復；再次開啟又重現。這證明原本的 0–50 ms 視訊目標在該 iPad
造成顯示凍結。本機 Chrome 先前測試只檢查解碼，也漏掉此失敗模式。

新版對 iPad Safari 不再發送 RTP 視訊播放延遲擴充；低延遲開關在 iPad
只縮短主機音訊積壓上限。頁面會明確顯示視訊目標已停用，不宣稱畫面
延遲因此下降。其他接收端如持續解碼但 2.5 秒沒有呈現畫面，頁面會
自動關閉該模式。整合測試現會同時確認解碼與畫面呈現持續前進，並模擬
iPad 桌面版 user agent 驗證安全路徑。實際 iPad 修正版尚待重測。
新版網頁遇到仍在執行的舊版 bridge，會停用 iPad 的低延遲勾選框並提示
重啟 bridge，避免只重新整理網頁就重現凍結。
