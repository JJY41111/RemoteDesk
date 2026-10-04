# RemoteDesk 正式 iPad App 0.4.0

此目錄為獨立 Xcode 專案，安裝後不依賴 Swift Playgrounds。UIKit 接收器直接作為 UIWindow 的根控制器；GCKeyboard、GCMouse、GCController 提供原生輸入，影音與既有功能仍由 WKWebView 接收。沒有改動主機影音參數，不保證打包即可修復游標鎖定。

## 免費測試安裝（Windows）

1. GitHub Actions 的「Build iPad App」成功後，下載 `RemoteDesk-unsigned-ipa` artifact，解壓取得 IPA。這是未簽署檔案，不能直接在 iPad 點擊安裝。
2. 依 AltStore Classic 官方 Windows 說明安裝 AltServer 及必要的 Apple 元件：https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows 。首次以 USB 連線 iPad、信任電腦，經 AltServer 安裝 AltStore Classic。
3. 在你自己的電腦／AltStore 登入 Apple 帳號。不要把密碼傳給開發者、放進程式或 GitHub Secrets。必要時依系統提示啟用 iPad 開發者模式。
4. 把 IPA 存到 iPad「檔案」，使用 AltStore Classic 的 My Apps → + 選取 IPA，完成個人簽署與安裝。
5. 免費個人簽署通常七天到期；到期前讓 AltStore 與電腦 AltServer 連通並重新整理 App。Apple 的帳號與裝置限制仍適用：https://developer.apple.com/help/account/basics/about-your-developer-account 。

## 驗收

啟動頁確認 0.4.0 → 輸入目前主機 HTTPS 網址 → 配對／啟用操作 → 測 WASD 與滑鼠同時使用、右 Shift、Xbox。點「遊戲滑鼠」後，必須頂端顯示「游標已鎖定」、游標消失且能越過原螢幕邊界持續旋轉，才算第一人稱通過。保留主畫面網頁版供日常使用。

既有 CA 需完整信任，跨區仍需要 Tailscale；本 App 不繞過 TLS。模擬器只證明編譯與基本啟動，不證明 iPad 實體鍵鼠、游標鎖定或串流品質。

## 維護

PointerController.swift 是 0.3.1 輸入橋接的明確快照，後續正式 App 修改以本目錄為主；舊 Playgrounds 專案保留作歷史參考。最低 iPadOS 17，無第三方 Swift 套件、無 Apple 簽署秘密。
