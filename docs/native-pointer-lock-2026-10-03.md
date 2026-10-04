> 2026-10-04 已停止原生 App 路線。以下僅為歷史紀錄，不再提供安裝或續作。改用 ipad/README.md 的主畫面網頁版。

# 2026-10-03.6／App 0.3.1 原生游標鎖定失敗

使用者回報：新 RemoteDeskApp.swiftpm 已在 Swift Playgrounds 執行，只有 RemoteDesk 佔滿螢幕，頂端顯示「系統未鎖定」；Minecraft 隨 iPad 游標轉向，碰邊框不能繼續。08:23:58 CSV 有76筆相對模式、142筆桌面模式，全部有效記錄 mouse_pointer_locked=0。相對模式最早08:22:06.401Z、最晚08:23:48.456Z；這不是確認完整連續區間。由此確定上版沒有達到真正原生鎖定，不能把有相對指令當作修好。

## 本次修改

上版 NativeWindow.open 從 UIApplication.connectedScenes 任取第一個 foregroundActive scene，另建 UIWindow；沒有選用啟動頁實際 window。這是多場景下的選用缺陷，但尚未證明它是此次失敗的唯一原因。

App0.3.1 用 UIViewRepresentable WindowProbe 取得啟動頁的實際 UIWindow；由該窗口現有 presenter 以 modalPresentationStyle.fullScreen 呈現 PointerController。取消另開 UIWindow、任取前景 scene 與前一窗口切換。Apple 的 UIKit 說明指出系統會隨呈現／退出控制器更新游標鎖定偏好，因此採既有呈現層級；不注入私有API或偽造 isLocked。

新增 viewDidAppear 更新偏好、鎖定通知、原生重試按钮與具體狀態：scene unavailable、未活動、尺寸未滿版、主視窗、覆蓋控制器、UIKit讀取prefersPointerLocked次數。尺寸只是場景幾何診斷，不能排除看不見的Slide Over或其他系統政策。記錄查詢次數不能代表鎖定成功。

CSV新增 native_app_version、native_capture_requested、native_lock_available、native_lock_queries、native_scene_width/height，沿用 isLocked 真實結果、epoch與输入去重；未調整解析度／FPS／編碼／音訊。

## 依據與驗證

- Apple: https://developer.apple.com/videos/play/wwdc2020/10094/ — 既有控制器呈現、場景活動、場景實際全螢幕及isLocked；UIRequiresFullScreen不等於滿版，不靠plist强迫鎖定。
- Apple: https://developer.apple.com/documentation/uikit/uiviewcontroller/preferspointerlocked — 系統可能不接受偏好。
- Windows原生橋接模擬（鍵盤、手把、模式/epoch、滑鼠去重）及iPad尺寸UI回歸通過。新Swift尚未在iPad編譯或執行，無Xcode/iOS SDK，不能宣稱修好。

下一步：使用者確認啟動頁0.3.1、按遊戲滑鼠/重試后的完整頂端狀態、主控台與CSV，核對是否要求被讀取與場景可鎖定。若仍未鎖定，先依新證據定位，不反覆加要求、不改影音參數。

## 2026-10-04 使用者影片驗收：仍失敗

使用者提供 ScreenRecording_10-04-2026 14-57-29_1.mp4（約11.87秒），並回報Swift Playgrounds較主畫面網頁不穩、鍵盤常偵測不到。已檢視影片擷取：開頭有控制中心，其後 RemoteDeskApp 接收器滿版；後段頂端明示「系統未鎖定・鎖定要求查詢1次・鍵盤已連接・手把未連接」，系統游標仍可見、可抵達右邊界。不能指認最初控制中心就是後續一直拒絕鎖定的原因。

0.3.1的UIKit偏好已被讀取，但沒有真正鎖定，因此上次視窗選用修正沒有解決實機問題。影片中的鍵盤已連接僅證明裝置存在，不證明按鍵被成功轉送；短片不能定位鍵盤間歇偵測失敗、量化影音延遲或證明原生App普遍較慢。

使用者詢問主畫面網頁能否融合滑鼠。重新查MDN官方browser-compat-data Element.requestPointerLock，safari_ios.version_added=false；WebKit216621仍NEW。網頁支援絕對定位/點擊/滾輪與有限相對移動，但PWA不自動取得GameController原生權限，不能把CSS隱藏游標、pointer capture、邊緣連續旋轉當作真實無限相對移動。也不能承諾更新OS就解決。需區分目前已可用日常PWA與未通過的FPS鎖定。

此輪未修改Swift、影音或服務。停止無實機依據的視窗重試修改；若走正式原生接收器，仍需正式建置/簽署与iPad驗收，不能宣稱只要打包正式App就一定解決。保留PWA日常鍵盤滑鼠與手把，按使用者後續方向處理。

資料：https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Element.json；https://bugs.webkit.org/show_bug.cgi?id=216621。
