# 虛擬 Xbox 手把安裝與驗證（2026-09-25）

RemoteDesk 的瀏覽器到主機手把封包與 VIIPER API 連接器由本專案實作；
Windows USBIP 核心驅動及 VIIPER 可攜程式為第三方元件。

## 安裝內容

- USBIP-Win2 0.9.8.0 x64：官方 GitHub 發行檔 `USBip-0.9.8.0-x64.exe`。
  SHA-256 `81F426741F7EE2ED991FEBE24A22DACA8400B6AE2F171054E3FB404897E15D39`；
  Windows Authenticode 狀態為 Valid，簽署者為 Cloudyne Systems
  (Scheibling Consulting AB)。已安裝到 `C:\Program Files\USBip`。
- VIIPER 0.7.1 Windows amd64 可攜版：官方 GitHub 發行檔
  `viiper-windows-amd64.zip`。SHA-256
  `1DDDC26CE410E3190AB19246A06AA4B61CF51814A32AAD4C7ADFF358E5AAA224`；
  解壓於 `bridge/private/viiper`，此目錄不進 Git。其 exe 未簽章，
  以官方發行檔雜湊驗證來源。
- 安裝前後比對 Windows LocalMachine Root 憑證，沒有新增根憑證。
- USBIP 安裝器回報驅動安裝成功，但濾鏡驅動安裝回傳 3010，表示系統
  要求之後重開機；本次未自動重開。

## 主機驗證

VIIPER 僅綁定本機 `127.0.0.1:3241` 和 `127.0.0.1:3242`。
透過本專案的 VIIPER 連接器建立虛擬 Xbox 360 手把時，
`usbip.exe port` 顯示 `Microsoft Corp. : Xbox360 Controller (045e:028e)`；
Windows `XInputGetState` 第 0 號手把回傳 0（成功）。持續送 A 鍵後，
XInput 的 Buttons 為 `0x1000`，與 Xbox A 鍵一致。
這只驗證同一台 Windows 主機上的虛擬手把，尚未驗證 iPad Safari、
藍牙手把、WebRTC 輸入通道與實際遊戲整條路徑。

主機以 `--enable-input` 啟動後，iPad 連線並按「啟用虛擬手把」，
橋接程式會視需要從 `bridge/private/viiper/viiper.exe` 啟動 VIIPER，
再建立虛擬 Xbox 手把；按「停用虛擬手把」會移除本次建立的裝置。
`--gamepad=viiper` 仍可預先啟動 VIIPER，但不再自動建立虛擬手把。
若已有運行中的 VIIPER，橋接程式會沿用現有服務，不會停止它。

## 來源

- https://github.com/vadimgrn/usbip-win2/releases/tag/v.0.9.8.0
- https://github.com/Alia5/VIIPER/releases/tag/v0.7.1
- https://github.com/Alia5/VIIPER/blob/main/docs/getting-started/installation.md
