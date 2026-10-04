# iPad 實體鍵盤輸入修正（2026-10-02.7）

問題分成兩段。瀏覽器的文字框只把 `input` 當文字傳輸，方向鍵與 Shift 在框內原本不會送往主機；Safari 若未提供標準 `code`，單獨 Shift 又會變成沒有 Windows 對應的 `Shift`。主機 `MapVirtualKeyW(..., MAPVK_VK_TO_VSC_EX)` 在本機對方向鍵回報 0x004B／0x0048／0x004D／0x0050，沒有 E0 前綴；原輸入助手因此把它們當非延伸掃描碼送出，可能被辨識為數字鍵盤鍵。

更新：優先以 `event.key` 辨識方向鍵（包含舊名稱），在 `code` 缺失時依 `location` 辨識左右 Shift；文字框內的方向鍵與 Shift 改走按鍵按下／放開事件，阻止瀏覽器在本地文字框處理方向鍵。診斷框改為唯讀。Windows 對應區分 `VK_LSHIFT`／`VK_RSHIFT`，方向鍵及 Home／End／Page Up／Page Down／Insert／Delete 強制設 `KEYEVENTF_EXTENDEDKEY`。這只修正掃描碼，不改動文字輸入或遊戲手把路徑。

驗證：21 項 Node 單元測試、Chrome UI 的左 Shift、方向鍵與無多餘文字事件測試通過；輸入助手以獨立候選檔用 MSVC 編譯成功、可列出螢幕。本機只查詢按鍵掃描碼，沒有向使用者桌面注入測試鍵。iPadOS 可能攔截某些實體鍵，主機輸入法也須設定為左 Shift 切換中／英；這兩項須實機驗收。

使用者斷開跨區操作後，已備份原執行檔、替換正式輸入助手並比對候選檔 SHA-256；新版可列出主機螢幕。9443／8443 沒有重啟，跨區頁面 2026-10-02.7 回 HTTP 200。等待部署用的暫時監控遇到舊 PowerShell 缺少 `Get-FileHash`，雖已複製成功仍會重試；在獨立確認雜湊後，已停止並移除監控程式。部署結果見 `bridge/private/input-deploy-20261002.log`。iPad 實際中英切換與方向鍵動作仍待使用者重連驗收。

## 右 Shift 追查與服務更新

iPad 實測確認方向鍵已正常；頁面診斷顯示實體右 Shift 為 `key=Shift, code=ShiftRight`。因此 iPad 端辨識無誤。發現先前只部署了新的 Windows 輸入助手，未重啟已載入舊 `input-map.mjs` 的 Node 服務；該服務仍將 ShiftRight 映射為一般 Shift（0x10），主機會按左 Shift 掃描碼送出。使用者斷線後已依序重啟無活動連線的 9443 和 8443；兩者 HTTP 200，新服務載入 `VK_RSHIFT`（0xA1）對應。新增 ShiftRight 瀏覽器按下／放開測試，UI 與 21 項單元測試通過。右 Shift 是否切換使用者 Windows 輸入法仍需重連實測。
