# RemoteDesk 延遲續作 checkpoint

## 2026-09-29 新進度（以本節為準）

使用者新一輪 iPad CSV 與回報：主機《漫威蜘蛛人 2》本身順暢且高於 60 FPS，iPad 約 20–30 FPS；150% 檢視放大仍無法解決字糊。CSV 後段接收端解碼與呈現一起下降，視訊封包遺失、bridge 丟棄、瀏覽器丟棄均為 0；詳見 `docs/performance-quality-2026-09-29.md`。前一版「等待 150% 放大驗收」已結案為無效解法。

已加 D3D11 GPU 縮放／轉色、串流時停用本機預覽、原生 2560×1440 文字模式、每秒主機送出 FPS 與擷取／編碼效能紀錄。本機隔離埠實際 WebRTC 測試已通過 1080p 與原生畫面；1080p 三分鐘測試 179 個逐秒樣本編碼最低 59.4 FPS、零 bridge 丟棄。原生 Chrome 仍有呈現丟幀，遊戲仍應以 1080p 為預設。11 項單元測試與 Chrome 介面測試通過。未停止使用者服務、未安裝驅動。

下一步是使用者重啟原 bridge 載入新版，在 iPad 依 `docs/performance-quality-2026-09-29.md` 做至少三分鐘遊戲與同畫面文字對照，回傳 CSV／截圖／`runtime.log`。尚未獲得這版 iPad 結果，不能宣稱遊戲 FPS 或文字品質已達標。若無新實機資料，保持安靜，不重跑相同本機測試。

---
更新時間：2026-09-28T23:28:42.985Z

## 當前狀態
2026-09-29 文字清晰度更新：接收端現有 150% 檢視放大、拖動畫面，保留 1920×1080 傳送解析度；iPad 尺寸的本機 Chrome 介面與座標測試通過。使用者下一次驗收時需比較相同文字在完整畫面／放大檢視的可讀性。Safari 實機畫質仍未確認，詳見 docs/text-clarity-2026-09-29.md。
本輪可在Windows自主完成的修正與驗證已完成，下一步需iPad實機回饋。
沒有新實機資料或新失敗時，不重跑測試、不再重構、不重複通知。
使用者尚未確認新版效果，不能稱已達成iPad低延遲驗收。

## 已完成
- 預設 interactive：分開影音MSID與CNAME，避免影音同步策略讓畫面等待延遲的音訊；配對前可選av-sync保留唇形同步。
- 按播放才送音訊，暫停停止RTP並清空舊PCM；恢復時保持RTP時鐘跨越停播時間。
- 正式路徑完全移除造成iPad凍結的0–50ms RTP視訊擴充。
- 原開關改名「縮短主機音訊排隊（進階）」，預設關閉，清楚說明只影響主機PCM。
- 主機/接收端協定版本4；舊主機提示重啟。
- 新CSV有sync_mode、audio_on_demand、video_packets_lost_total、video_bitrate_kbps、video_decode_ms、rtt_ms、video_paused。
- 11個unit tests、UI、實際影音配對/呈現/暫停/恢復/再配對/CSV均通過。
- 45秒實際音訊播放的對照：加600ms音訊傳送延遲，同步模式視訊峰值489ms，interactive峰值18ms。
- 300秒1080p合成畫面反覆音訊延遲：視訊buffer峰值13ms，audio峰值1202ms，無零呈現樣本。合成流量低，不是高動態遊戲、WiFi或iPad驗證。
- 所有測試僅用8544/55444；未中斷使用者原服務。
- 未修改C++、憑證或系統驅動。不需npm安裝或重編譯。

## 證據
- docs/latency-sync-2026-09-29.md：目前使用方式與限制。
- docs/latency-sync-validation-2026-09-29.json：永久摘要、原iPad CSV雜湊與對照。
- bridge/test-results/sync-*-playing-45s.json、sync-interactive-playing-300s.json：本機逐秒原始測試。
- 原CSV C:/Users/johnl/Downloads/remotedesk-metrics-2026-09-28T17-04-46-423Z.csv：勾選前已停頓/丟包，audio_playing全0，audio buffer603ms/video401ms/主機queue0，不能歸因主機queue開關。

## 使用者下一步
原主機視窗Ctrl+C，bridge目錄執行 .\start-ipad.cmd；iPad重新整理，選「即時操作」，用新配對碼。
先不播音訊、再播放音訊比較主機與iPad螢幕時間差。無需勾進階PCM選項。
不要重新啟用0–50ms RTP方案，不要把本機13ms接收buffer當端到端延遲。
既有續作排程active，每兩小時確認額度與新資料；無新增可行工作保持安靜。
