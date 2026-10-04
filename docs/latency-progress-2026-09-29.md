# RemoteDesk 延遲續作 checkpoint

## 2026-10-01 跨地區連線優先（最新）

使用者明確要求暫停遊戲 FPS 調校，先讓在學校的 iPad 能從外網連回家中主機。主機已安裝、登入 Tailscale；RemoteDesk 新增只綁主機 Tailscale IPv4 的 `--tailnet` 與 `npm.cmd run start:tailnet`。獨立 9443 服務已啟動，原 8443 區網服務保留。主機同機經 Tailscale IP 的 HTTPS／WebRTC 1080p60 測試通過；使用者已在學校 iPad Safari 成功打開配對頁並看到家中桌面。Tailscale 起初走香港 DERP 約 194–229 ms，串流後已切成直連約 27 ms；鍵鼠實際反應及 iPad 聲音仍待回報。詳見 `docs/cross-region-2026-10-01.md`。目前繼續驗證跨區操作，不回到家中區網遊戲 FPS 調校。

---

## 2026-10-01 重負載遊戲可選模式（最新）

依據使用者 15:54Z 約 10 分 40 秒 iPad CSV，確認同場次既有主機 GPU 讀回塞住與接收端突發遺失兩種卡頓。預設 1080p60 保留，CPU 轉色比較模式因主觀與主機紀錄均不佳而移出一般選項；新增可選同解析度 GPU 1080p30／10 Mbps 重負載測試模式。隔離 Windows 真實 WebRTC 驗證 1080p30 與原本 1080p60 均通過，13 項單元及 Chrome UI 通過；iPad 遊戲同場景 A/B 尚未做。詳見 `docs/heavy-game-2026-10-01.md`。不要把本機結果當作遊戲改善，也不要改掉已達標的預設模式。

---

## 2026-09-30 14:48Z 遊戲退步驗收（優先於下方紀錄）

新 iPad CSV 顯示進入遊戲負載後主機送出 58.5 → 35.3 FPS、iPad 解碼 59.4 → 34.3 FPS、視訊遺失計數 0 → 1900；詳見 `docs/game-regression-2026-09-30.md`。GPU 非阻塞三槽方案在實際遊戲下讀回年齡達約 183 ms、佇列累計滿載 819 次，不能稱已修好。已增加配對時可選的同解析度 CPU 轉色比較模式與主機實際擷取更新 FPS，Windows 隔離埠測試通過。需使用者在同一《蜘蛛人 2》場景做 GPU/CPU A/B 並留新 CSV、runtime.log；不要僅憑本機靜態桌面數字改預設或回退到先前亦有十多 FPS 的同步 GPU 版本。

---

## 2026-09-30 22:26 實測後的新進度（優先於下方舊紀錄）

最新兩份 CSV（14:25:12Z 與 14:26:07Z）已讀取。這次瓶頸在主機：1440p 最後送出 6.9 FPS，1080p 後段約 11–24 FPS 且視訊遺失 0。原主機 runtime.log 已保留為 `docs/game-load-2026-09-30-runtime.log`，顯示 GPU 轉色／同步讀回耗時從約 2 ms 升至 35–89 ms。不要再沿用上一份 CSV 的「主機穩定 60、優先查網路」判斷。

已改 C++ 網路串流為三槽非阻塞 GPU 讀回、最新完成畫面優先、固定排隊上限、正常時最多 1 ms 有限輪詢，加 GPU 完成時間與略過計數。詳見 `docs/gpu-readback-2026-09-30.md`。已完成本機編譯與正常桌面 WebRTC 驗證；遊戲未執行，仍需同場景 iPad CSV 與新版 runtime.log。維持解析度、位元率、GPU 色彩處理，沒有重啟使用者 bridge、沒有安裝驅動。

---

## 2026-09-30 新進度（以本節為準）

使用者最新 16 分鐘 iPad CSV 顯示主機平均送出 59.9 FPS、bridge 丟棄 0，但呈現有 37 秒低於 45 FPS，封包遺失計數與卡頓相關；詳見 `docs/game-stability-2026-09-30.md`。日常操作、選擇播放方式和畫質獲使用者肯定，遊戲穩定與手把延遲仍未達標。

已把手把改成獨立不保序、零重傳的快速通道，加序號防舊狀態倒退及積壓略過，並保留可靠歸零。12 個單元、Chrome UI、隔離埠實際 WebRTC 均通過。視訊 pacing 實驗導致本機緩衝與 FPS 大幅退步，已撤回；不能宣稱這次提升了畫面流暢度。原 bridge 服務未重啟，使用者尚未測新版手把。下次需新 iPad CSV 與同場景主觀比較；不要以本機靜態桌面測試代替遊戲驗收。

---

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
