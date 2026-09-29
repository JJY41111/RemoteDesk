# RemoteDesk 原生 iPad App（Swift Playgrounds 實機驗證版）

`RemoteDesk.swiftpm` 是 SwiftUI 原生 App，使用 WebRTC 的 iOS 原生 SDK，
並非將原網頁包進 WebView。它沿用 Windows `bridge/server.mjs` 的配對、
WebRTC 畫面／音訊、輸入和虛擬手把協定。WebRTC 二進位套件來自
[stasel/WebRTC 153.0.0](https://github.com/stasel/WebRTC/releases/tag/153.0.0)，
並不是 RemoteDesk 自製的系統驅動。

## 目前驗證界線

- Windows 端訊號 Origin 擴充及既有 Node 協定測試已通過。
- Swift 原始碼與 `.swiftpm` 專案已建立，但目前環境沒有 Mac/Xcode，
  **尚未編譯，也尚未在 iPad Air 6 執行**。
- Apple 的 Swift Playgrounds 能在 iPad 編輯並執行 App，且支援加入 Swift 套件；
  本專案用的第三方 WebRTC 套件包含 XCFramework。此組合是否能在你的
  Swift Playgrounds 版本載入，必須在 iPad 上試開後才知道。
- 原生 WebRTC 不保證比 Safari 的 WebRTC 更低延遲；待實機可執行後，
  仍需同場景測量畫面延遲和卡頓。

## 在 iPad 上試開

1. 在 iPad 安裝 Apple 的 **Swift Playgrounds**，確認有足夠空間下載 WebRTC 套件。
2. 將 `RemoteDesk.swiftpm` 整個資料夾傳到 iPad「檔案」App。
   若使用 `RemoteDesk-iPad-source.zip`，先在「檔案」App 解壓縮。
3. 點開 `RemoteDesk.swiftpm`，選擇 Swift Playgrounds。首次開啟可能需要下載
   `stasel/WebRTC` 套件；保留實際錯誤截圖以便修正。
4. Windows 主機先在 `bridge` 執行 `npm.cmd run preflight`，確認目前區網 IP，
   再用原本能連線的 `npm.cmd start` 參數啟動新版 bridge。
5. iPad 必須在同一可信區網。沿用 Safari 測試時安裝並在 iPad 設為完全信任的
   RemoteDesk CA；App 使用正常 TLS 驗證，不會忽略憑證錯誤。
6. 在 App 輸入 Windows 區網 IPv4 和主機本次啟動顯示的 8 位配對碼。
   先驗證畫面與音訊，再開遠端操作，最後才啟用虛擬手把。

## 啟動當機時的診斷版

目前壓縮檔先顯示「原生 App 已啟動」，再由「開啟遠端介面」進入串流畫面。
如果第一個畫面也無法出現，問題發生在遠端介面建立前；如果按按鈕後才
當機，問題較可能在遠端介面或 WebRTC 視訊元件初始化。

在 Swift Playgrounds 點「顯示 Playground」，開啟程式碼編輯器的「主控台」後
重新執行，回傳最後幾行訊息（尤其是 `RemoteDesk diagnostic:` 開頭的訊息）。
不要按當機選單中的「刪除 App 資料與重新啟動」；這不會提供真正的錯誤原因。

如果連第一個畫面都沒出現，改開 `RemoteDesk-iPad-smoke.zip` 內的
`RemoteDeskSmoke.swiftpm`。它保留 iPad App 的基本專案設定，但完全不引用
WebRTC 套件，也不含遠端介面。若它能啟動，可排除最基本的 SwiftUI／專案啟動問題；
仍不能單憑此結果把原因確定為 WebRTC。若它也當機，請回傳 Swift Playgrounds
主控台或 iPad 分析資料中的實際錯誤，才有足夠證據進一步修正。

## 目前 App 功能

- 原生 WebRTC 接收 H.264 畫面與 Opus 音訊。
- SwiftUI 連線介面、一次性配對碼、遠端操作開關。
- 觸控左鍵、指標移動、外接滑鼠右鍵與滾輪、實體鍵盤按下／放開、
  文字輸入、遠端 Win/F5。外接滑鼠行為尚待 iPad 實機驗證。
- GameController 讀取 iPad 上的 Xbox 手把，轉送按鈕、扳機與雙搖桿，
  並請求 Windows 建立／移除既有 VIIPER 虛擬手把。

目前尚未實機驗證滑鼠右鍵、滾輪、實體鍵盤所有組合鍵、音訊裝置切換、
斷線恢復與主機端卡頓原因。原網頁的「低延遲模式」使用 Safari 不支援的
接收緩衝 API；2026-09-29 網頁改為主機控制，但 iPad 實測 RTP 視訊
播放延遲設定造成畫面凍結，現已對 iPad 停用，只調整音訊排隊上限，
詳見 [新版網頁低延遲實作與驗證](../docs/web-low-latency-2026-09-29.md)。
原生 App 仍未成功在 iPad 啟動，尚無原生與網頁效能比較結果。

## 安全邊界

僅在可信區網使用。新版 bridge 允許無 `Origin`、但帶
`X-RemoteDesk-Client: ipad-native-v1` 的原生 WebSocket 握手；
所有用戶端仍須通過 TLS、8 位配對碼與主機的遠端操作開關。
勿將 8443/8444 或本機 TCP 連接埠轉發到公網。
