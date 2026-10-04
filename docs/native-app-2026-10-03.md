> 2026-10-04 已停止原生 App 路線。以下僅為歷史紀錄，不再提供安裝或續作。改用 ipad/README.md 的主畫面網頁版。

# 2026-10-03.5 RemoteDesk App

使用者要求以現有架構做成 App，鍵盤滑鼠須同時可用。新增 RemoteDeskApp.swiftpm；保留先前 Pointer 與完整 WebRTC 專案，未更動影像、音訊、解析度、FPS、位元率或恢復模式。

- 原生 GCKeyboard 回傳 HID 實體鍵 down/up，含左右 Shift、WASD、多鍵組合、F1–F12、Meta、方向鍵、標點、CapsLock 與 Insert。主機增加後兩鍵 VK 對應。GCKeyboard 依 Apple 官方 API；不是從瀏覽器推測實體鍵。
- 原生 GCMouse 與 UIPointerLockState 沿用 .4 真實锁定路徑。普通桌面仍採 WKWebView 指標定位，鎖定時忽略 DOM 重複滑鼠事件。
- 原生 GCController extended profile 取得 Xbox 標準17按鈕與4軸，Y軸轉換，保留類比板機；60Hz主執行緒送變更/100ms保活，沿用序號與手把快通道。系統保留按鍵待實機驗證。
- 鍵盤只有遠端画面聚焦且操作已啟用時轉送，不要求鼠標鎖定；轉到本地文字欄位會送 key up。epoch拒絕過期批次，停用/背景/失焦釋放；GC鍵盤斷線清佇列、釋放且清callback；返回移除所有輸入callback/observer/displaylink。
- GameController與WKWebView同時可能產生鍵盤事件，原生轉送時preventDefault並忽略DOM鍵碼，防止雙重按下。原生App不輪詢navigator.getGamepads。
- 每次最多一個 evaluateJavaScript 批次；輸入不等待視訊畫面回報。JS超過1秒無回應釋放控制，不將排隊當作低延遲。TLS維持正常驗證，限定配置伺服器同來源主框架。

## 驗證

26 Node、既有 iPad UI、原生橋接模擬測試通過。新增鍵盤組合、右Shift、箭頭、F5、不依賴滑鼠锁定、DOM去重、文字欄位釋放、過期拒絕、停用拒絕與原生手把路徑測試。

Windows沒有Swift/iOS SDK，因此Swift來源尚未編譯，iPad的啟動、鍵盤、指標鎖定、手把及WKWebView影音仍未驗收。ZIP是Swift Playgrounds App來源專案，不是簽章IPA。若無新iPad資料，不聲稱修復實機故障、不猜測重改Swift。

指南：ipad/README.md。下載路徑 /downloads/RemoteDesk-iPad-app.zip；無憑證私鑰或配對碼。

## 部署紀錄

確認原9443/8443 Node服務身分且無Established連線後更新。兩首頁顯示2026-10-03.5，App下載均HTTP200、7894 bytes，SHA-256與本機ZIP相符；stderr無錯誤。沒有修改原憑證、驅動或VIIPER後端。此紀錄仍不是Swift編譯/iPad驗收。
