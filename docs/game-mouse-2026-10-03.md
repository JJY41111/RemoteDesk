# 2026-10-03.3 遊戲視角相對滑鼠修正

使用者回報 Minecraft 視角固定看腳，但鍵盤走路、切工具、開箱正常。07:05:55 CSV 約十分鐘、1920×1080、1080p 預設模式、啟用遠端操作、手把未啟用；操作啟用樣本呈現平均58.67FPS。舊CSV沒有滑鼠位移或相對模式欄位，不能用此紀錄證明遊戲視角原因。

原程式僅將瀏覽器點擊位置轉成 Windows MOUSEEVENTF_ABSOLUTE，全畫面遊戲則常用游標相對中心的位移轉向，絕對輸入可能令視角持續偏向螢幕底部。新增可選「遊戲滑鼠」，不更動影音參數或預設桌面滑鼠。

## 行為

- 先勾選遠端操作，再按功能→遊戲滑鼠。
- 支援 Pointer Lock 時，鎖定游標並讀 movementX/Y，可以連續轉向；Esc 釋放游標。依[Pointer Lock 文件](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API)做執行期偵測，不宣稱所有iPad Safari版本支援。
- 不支援或拒絕鎖定時，以相鄰座標差做相對移動；可拖曳觸控轉向，抬手後重新拖曳不跳轉，輕點左鍵，鼠標左右鍵正常。此退路仍受iPad游標螢幕邊緣限制，並非無限實體滑鼠轉向。
- 每個動畫影格累加移動量（不是只保留最後一筆）；相對移動走可靠有序控制路徑，避免將增量放在會遺失／亂序的位置快通道。
- 主機確認模式後才傳增量。相對模式忽略遲到的絕對座標，點擊不再額外傳桌面位置；Windows透過SendInput MOUSEEVENTF_MOVE送相對移動。退出模式/遠端控制時歸零待送資料與按鍵，桌面預設仍保留。
- CSV新增mouse_mode、mouse_pointer_locked，區分實際模式及瀏覽器游標鎖定。

## 已驗證

Windows C++新輸入助手編譯到out/remote_desk_input.next.exe。隔離Chrome頁面測試通過：多事件累加、相對模式右鍵不送絕對位置、觸控拖曳不按住攻擊、鎖定時不重複送PointerEvent與MouseEvent、切回桌面恢復位置輸入。

尚未用iPad/Minecraft驗收；亦未量測遊戲是否接收合成相對輸入。當時9443仍有使用者工作階段，未替換正在使用的輸入助手；部署與真實Windows游標驗證須在斷線後執行。

## 部署結果

使用者確認斷線後，07:18Z備份原輸入助手到out/remote_desk_input.before-game-mouse.exe，再替換新版並更新9443與8443。兩頁HTTP200且版本2026-10-03.3，stderr無錯誤。26 Node測試及既有iPad尺寸UI回歸通過，隔離19553/19554的真實Windows輸入助手READY驗證通過；此測試不送實際滑鼠移動，不能當作Minecraft相對輸入驗收。
