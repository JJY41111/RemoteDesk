# iPad 主畫面網頁 App（2026-10-02.5）

接收頁新增 Web App Manifest（`display: standalone`）、Apple 主畫面標籤與 180／192／512px PNG 圖示。從 iPad Safari 的分享選單選「加入主畫面」後，應從主畫面圖示以獨立視窗開啟，少掉 Safari 分頁與網址列。採用 standalone 而不是 fullscreen，保留系統狀態列及安全邊界，也避免強制進入先前曾有鍵盤焦點問題的網頁 Fullscreen API。

網頁 App 的起點與範圍都限制在目前 HTTPS origin。區網 `192.168.0.95:8443` 與跨區 Tailscale `100.124.244.122:9443` 是不同 origin；請從實際要使用的跨區 URL 安裝。配對碼仍由主機每次啟動時產生，不寫進圖示、Manifest 或離線快取。未加入 Service Worker，斷網時不假裝能使用遠端桌面，也不快取敏感畫面。

驗證：隔離 8546/55446 埠實際 HTTPS 服務回傳描述檔、正確 MIME 與三個尺寸的 PNG；原 UI 回歸測試通過。更新兩個服務後，跨區 9443 與區網 8443 的 Manifest 都回 HTTP 200。iPad Safari 實際「加入主畫面」流程及獨立視窗仍待實機確認；本機 Chrome 測試不能代替這項驗收。
