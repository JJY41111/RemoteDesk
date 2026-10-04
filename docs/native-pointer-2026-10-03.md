> 2026-10-04 已停止原生 App 路線。以下僅為歷史紀錄，不再提供安裝或續作。改用 ipad/README.md 的主畫面網頁版。

# 2026-10-03.4 原生游標鎖定接收器

使用者要求隱藏游標、不受邊框限制的第一人稱視角。Safari/PWA原本相對座標退路仍受邊框限制，不能冒充真正鎖定。本次新增獨立Swift Playgrounds專案`ipad/RemoteDeskPointer.swiftpm`，保留舊原生WebRTC專案，未修改影音編碼、解析度、FPS或傳输參數。

## 實作與依據

- [Apple GCMouseInput](https://developer.apple.com/documentation/gamecontroller/gcmouseinput)取得原始移動量、按鍵、滾輪；Y軸轉換採Apple座標到Windows向下為正。該方向也與[Moonlight原始碼](https://github.com/moonlight-stream/moonlight-ios/blob/master/Limelight/Input/ControllerSupport.m)的轉換一致，未複製其程式碼。
- [prefersPointerLocked](https://developer.apple.com/documentation/uikit/uiviewcontroller/preferspointerlocked)設定意願，系統可能拒絕；實際以[UIPointerLockState.isLocked](https://developer.apple.com/documentation/uikit/uipointerlockstate/islocked)確認後才接受原生輸入。使用SwiftUI啟動頁，再建立同場景的獨立UIWindow，確保原生接收器是頂層controller，不依賴SwiftUI轉送锁定屬性。
- WebKit沿用配對、WebRTC與既有工具列。主機確認相對模式後，頁面通知原生層要求鎖定。原生輸入每顯示更新批次回傳，JavaScript一次最多一個待執行批次，模式epoch排除過期結果；移動合併保留小數，點擊前先送移動量，避免打一幀前的位置。
- 只有使用者輸入的HTTPS主機同來源主框架可通知原生層；導向其他來源取消。CA驗證保留系統預設，不接受所有server trust，不傳送配對碼到其他網站。
- 真正原生鎖定期間忽略WebKit重複滑鼠位置/按鍵/滾輪事件。Esc、釋放、斷線、停用控制、拔滑鼠、背景與返回會解除鎖定並釋放輸入。未建立鎖定時不假裝已成功，也不把系統游標邊框藏起來稱為無限轉向。
- 未移除舊App依賴或重寫串流服務。新專案沒有外部Swift Package，只有Apple框架；啟動成功後按鈕才建立WKWebView，不保證既有Playgrounds啟動當機原因已解決。

## 驗證邊界

新增/延伸Chrome隔離測試：原生capture在主機相對模式確認後要求、鎖定結果、移動先於點擊、DOM事件去重、過期epoch拒絕及釋放後桌面輸入恢復；一般網頁相對/絕對路徑回歸通過。

Windows無Swift編譯器/iOS SDK，尚未編譯本Swift專案，也未在iPad執行。原生窗口是否真的取得鎖定、WKWebView音訊及鍵鼠、Minecraft是否接收輸入，都需要實機驗收；不因來源檔案/打包完成宣稱功能已在iPad修好。

## 部署

兩服務確認閒置後更新至2026-10-03.4。9443與8443首頁HTTP200、下載ZIP HTTP200，下載內容與專案ZIP SHA-256相符，stderr無錯誤。26Node、既有iPad尺寸UI與擴充的原生橋接測試通過。ZIP保留RemoteDeskPointer.swiftpm根目錄，含Package.swift及兩個Swift來源檔；不含憑證私鑰、配對碼或第三方SDK。

Swift Playgrounds驗收入口見ipad/README.md。必須先確認啟動頁，再確認網頁載入，最後確認頂端實際「游標已鎖定」及Minecraft完整轉圈；若任何階段失敗，保存主控台/截圖與CSV，不把瀏覽器模擬結果當成iPad成功。
