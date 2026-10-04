> 2026-10-04 已停止原生 App 路線。以下僅為歷史紀錄，不再提供安裝或續作。改用 ipad/README.md 的主畫面網頁版。

# 正式 iPad App 建置與免費安裝 — 2026-10-04

## 已完成的實作

使用者無付費 Apple Developer 會員、無 Mac；選擇免費測試安裝。
新增 ipad/RemoteDesk-iOS 獨立 UIKit Xcode 專案 0.4.0，以實際 UIWindow 根控制器接收，保留既有 GCKeyboard/GCMouse/GCController 與 WKWebView。
新啟動頁自行輸入 HTTPS 位址，不公開預設個人位址；CA 與 Tailscale 沿用現有設定，未繞過 TLS。
GitHub 分支 codex/ipad-native-app 只包含正式 App 和工作流程，未打包其他未提交修改，未變更主機串流參數或重啟服務。
PR: https://github.com/JJY41111/RemoteDesk/pull/1
初次 build: https://github.com/JJY41111/RemoteDesk/actions/runs/37185775817

## 安裝與驗收邊界

GitHub macOS 產生未簽署 IPA；由 Windows AltServer / iPad AltStore Classic 個人簽署，通常七天需要重新整理。使用者自行登入 Apple 帳號，不把帳號秘密放入 GitHub 或聊天。
目前雲端編譯執行中。完成後要記錄 device 編譯、simulator 編譯、啟動截圖和 IPA 雜湊。
模擬器無法驗證 iPad 實體鍵盤、游標鎖定、Tailscale/HTTPS 實際串流。正式 App 必須測 WASD + 滑鼠、右 Shift、手把、背景釋放，以及真正 isLocked；不能保證打包即修復。
PWA 留作日常使用，Swift Playgrounds 改作歷史参考，不繼續作為正式測試安裝入口。

## 下一步

修復雲端編譯/啟動的實際錯誤後提供 IPA 與免費安裝步驟。不得把未簽署 IPA 說成可以直接點擊安装。
完成可交付包後，再確認 Windows AltServer 是否已安裝及 USB iPad 是否可用，帳號步驟由使用者完成。
## 15:31 雲端驗證完成
Device Release 與 Simulator Debug 編譯成功；iPad 模擬器啟動 PID12465，五秒後仍在執行，截圖已人工檢視啟動頁0.4.0。IPA 59432bytes，SHA256 a71d24f9fe70b8419c6766946f5aa3022407348052957a3da02a45cf9a5d54fa。bridge/web/downloads/RemoteDesk-iPad-app.zip 已改為正式未簽署IPA及安裝說明的ZIP（60122bytes），不再是Playgrounds專案；服務未重啟。
使用者選擇現在接線安裝，並同意移除 Store iTunes改桌面版。AltServer官方MSI/EXE沒有Authenticode簽章，來源為官方CDN；一般安裝權限失敗1303，UAC重試exit0。Apple iTunes及iCloud安裝檔有效Apple簽章；目前安裝中。USB偵測Apple iPad與Apple Mobile Device USB Composite Device均OK。

## 15:41 Windows 安裝環境完成
Store iTunes已經使用者同意移除；桌面 iTunes12.13.11.1及AltServer1.8安裝完成。AppleApplicationSupport32/64、Bonjour64、AppleMobileDeviceSupport64均exit0；iCloud64安裝exit3010（成功但建議重新啟動），未重啟以保留RemoteDesk服務。Bonjour/AppleMobileDeviceService均Running，三項Apple/iPad USB裝置OK。AltServer與iTunes已啟動供使用者自行完成帳號/AltStore安裝。
HTTPS GET下載200/60122bytes，與正式包ZIP SHA256 9af22202d37636da39921c94fcd61abc27629cf1941e882eeb1c6a53ac7f7103 相符。HEAD不支援會404，不能當下載壞了。歷史配對碼已省略。
