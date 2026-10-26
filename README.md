# 集好運 · Community Lottery Winners

免 Python、免伺服器的 Chrome Manifest V3 擴充功能。使用繁體中文獨立工作分頁，擷取 Instagram 留言及回覆、設定資格、預覽籤數、抽獎並匯出 CSV。資料只存在本機。

## 安裝本機版本

1. 解壓縮 `artifacts/community-lottery-winners.zip`，或直接使用專案的 `dist` 資料夾。
2. 開啟 Chrome 的 `chrome://extensions`，啟用「開發人員模式」。
3. 按「載入未封裝項目」，選擇含有 `manifest.json` 的資料夾（`dist`）。
4. 登入 Instagram，開啟要抽獎的貼文，再點擴充功能圖示。
5. 在工作分頁確認網址、連接貼文，開始擷取。不要關閉來源分頁或將它切换成其他貼文。

程式執行不需要 Node.js、Python、登入資訊 JSON 或 Cookie 檔案。更新版本時重新建置，並在擴充功能管理頁按「重新載入」。請先暫停擷取。

## 交付狀態

已實作四階段操作、雙模式籤數、逐頁 IndexedDB 保存與續抓、抽獎快照、兩種 CSV、虛擬捲動與本機刪除。

2026-10-02 已在指定 Instagram 貼文完成 128 頁擷取，保存 1,839 則第一層留言與 13 則回覆；驗證暫停、關閉重開、來源切換保護、續抓、測試抽樣、兩種 CSV 及快照保存。81 項自動測試通過。資料範圍限於目前登入帳號可由查詢取得的內容。

**仍有一項實機驗收缺口：測試貼文的三串回覆皆在單頁內取完，回覆跨頁目前只有自動測試覆蓋。** 因此不能宣稱實作計畫中的全部實機案例已通過。細節見 [驗證紀錄](docs/VALIDATION.md)。

## 開發

使用 Node.js 24（目前驗證版本 24.20.0）及 npm：

```sh
npm ci
npm test
npm run build
npm run package
```

- `npm run dev`：僅本機預覽介面。一般網頁沒有擴充功能權限，只能操作示範資料。
- `npm run typecheck`：TypeScript 檢查。
- `npm test`：資格、抽獎、CSV、爬蟲、IndexedDB 自動測試。
- `npm run build`：輸出可直接載入的 `dist/`。
- `npm run package`：重新建置並產生 ZIP。
- `npx prettier --write src tests scripts *.json *.ts *.html docs README.md`：格式化。

## 文件

- [核心操作流程](docs/USER_GUIDE.md)
- [資格及抽獎規則](docs/RULES.md)
- [爬蟲及資料架構](docs/ARCHITECTURE.md)
- [驗證紀錄與實機清單](docs/VALIDATION.md)

改寫基準：[原專案 10715a0/main.py](https://github.com/Xunhaoz/Community-Lottery-Winners/blob/10715a0/main.py)。此次不包含 Chrome 商店上架或其他社群平台。
