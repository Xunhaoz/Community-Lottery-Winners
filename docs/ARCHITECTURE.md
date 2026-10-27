# 爬蟲與資料架構

## 執行邊界

TypeScript + React + Vite。`index.html` 是 MV3 的獨立工作分頁；背景 service worker 僅處理點擊入口及單次訊息轉送。所有執行碼封裝於 `dist`，不載入 CDN、遠端 JavaScript 或外部字型。

Manifest 只要求 `scripting` 與 `https://www.instagram.com/*`。沒有 cookies、webRequest、debugger、downloads 或全站存取權限。

每個請求由背景驗證發送者為本擴充功能工作頁、來源分頁 URL 與 shortcode 相符，再透過 `chrome.scripting.executeScript` 在 IG 分頁 MAIN world 發送同源請求。請求只用於讀取留言；瀏覽器自動攜帶登入 Cookie。GraphQL 所需的頁面 token 僅在該次來源頁函式內取得並使用，不傳回背景、不寫入 IndexedDB、不寫 log；不下載或保存 Cookie 檔案、完整認證標頭。

請求前後皆檢查來源 URL，導向其他貼文或關閉來源頁即停止。尚未完成的請求在 20 秒內逾時。工作分頁逐頁調度，避免依賴 service worker 的記憶體或長時間迴圈。

## Instagram adapter

`src/crawler/instagram.ts` 提供 `readPost`、`readComments`、`readReplies`。所有輸出為統一的留言 ID、作者 ID／帳號、本文、UTC 時間、父留言 ID、下一頁游標與回覆待辦。

原版 `10715a0` 使用 `33ba35852cb50da46f5b5e889df7d159` query-hash。此次在已登入的 Chrome 中觀察測試貼文實際請求，現行網頁使用 `/api/graphql`：

| 用途       | friendly name                      | doc_id            |
| ---------- | ---------------------------------- | ----------------- |
| 第一層留言 | PolarisPostCommentsPaginationQuery | 28169471862682868 |
| 回覆       | PolarisPostChildCommentsQuery      | 28027289793632076 |

這些是 2026-10-02 的觀察值，不是 Instagram 公開穩定 API。查詢變更後必須修改 adapter 並重新驗收，不能將缺少欄位預設為空陣列而假裝完成。

2026-10-26 起，第一層擷取改回 `GET /graphql/query/?query_hash=33ba35852cb50da46f5b5e889df7d159`，variables 為 `{shortcode, first: 50, after}`。回應 `shortcode_media.edge_media_to_comment` 是含回覆的平鋪清單，IG 實際照 50 筆分頁，`count` 等於貼文頁顯示的總留言數。web doc_id 每頁約 15 筆、採 `popular` 排序，曾觀察到少於貼文總數。平鋪模式不建立回覆待辦；回覆在平鋪清單中與第一層同列，`parentId` 為空。請求在來源頁內以 `csrftoken` cookie 帶 `X-CSRFToken`，不回傳。以 web 查詢開始、游標為 `{direction, value}` 包裝格式的舊活動與其回覆待辦，仍走 web doc_id 續抓。**平鋪查詢尚未在真實貼文以本擴充功能驗收。**

第一層回應為 `xdt_api__v1__media__media_id__comments__connection`，回覆為 `xdt_api__v1__media__media_id__comments__parent_comment_id__child_comments__connection`。media ID 以 shortcode 的 base64 字元表與 BigInt 精確轉換。程式使用數字形式 media ID；IG 網頁觀察到的是含作者尾碼的完整 ID，已在擴充功能自身請求中確認數字形式可以取得留言 JSON。

傳輸層接受 JSON 與 Instagram 實際使用的 `text/javascript` 媒體類型，皆以 JSON 解析，不執行回應程式碼；無效 JSON 以格式錯誤停止。

每頁要求 50 筆（IG 可能自行減少），保留不透明游標。向後翻頁以 `before/last`、向前以 `after/first` 表達；同一串固定行進方向。初始頁若兩個方向均有待抓資料，採未完成狀態停止，避免漏抓一邊。

平鋪模式以最新一頁的 `count` 為完整性目標（刪除留言可使其下降）。走完分頁時若唯一留言 ID 少於 `count`，保存資料並暫停，游標重設為第一頁；繼續擷取會重新走完整份清單，以 ID 去重，補上擷取期間新增在已走過位置的留言。若 IG 的 `count` 含帳號無法取得的留言，活動會保持未完成。

web 模式中，只有明確 `child_comment_count = 0` 可略過回覆請求。未知數量一律查詢回覆；正數回覆建立独立待辦並走完游標。預覽回覆從不視為全量。已觀察到的回覆数是完整性下限；終止時少於下限即保持未完成。

## 排程、鎖定與復原

工作頁使用 Web Locks 的全域寫入鎖，整個擷取工作持有鎖；所有 UI 的活動修改、抽獎與刪除也遵守同一把鎖。同時只有一個擷取／寫入工作。來源頁僅負責一次請求。

單線請求間隔 1.8 秒。只有暫時性網路錯誤或 HTTP 5xx 有兩次額外重試，等待 2 秒及 4 秒；429、登入失效、checkpoint/challenge、格式異常及來源切換立即暫停。

每頁在 IndexedDB 同一交易提交「新增原始留言＋游標與待辦＋進度」，提交失敗不得推進游標。跨頁相同 ID 不覆寫首次觀察的本文；同 ID 作者／層級衝突則拒絕該頁交易。游標重複及回覆缺漏仍保存當頁可用資料，但保持未完成。

工作頁關閉會釋放鎖。資料庫中殘留的 running 狀態，在重新開啟且成功取得鎖後轉為 paused。繼續時重讀資料庫最新狀態；目前尚未提交的一頁可重新抓取，由 ID 去重。取消保留資料但不能繼續；重新連接另建活動。

## 抽獎動畫

`src/ui/drawAnimation.ts` 以 1280×720 canvas 繪製。抽獎在動畫之前完成並以 `saveDraw` 寫入；動畫只讀取 `DrawRecord`，不使用、也不影響抽獎亂數。

`animationPlan` 依得獎人數排定時間軸：開場 1.2 秒、每位 1.4 秒、結尾總覽 1.8 秒，總長限制在 5–10 秒，超過時壓縮每位的揭曉時間。滾動用的候選帳號取自該次籤池，以抽獎紀錄 ID 為種子的確定性亂數挑選，最後一格固定為真正的得獎者。`renderFrame` 是 `(draw, t)` 的純函式，因此現場播放、重播、事後下載的畫面一致，歷史紀錄也能重新產生。

下載以 `canvas.captureStream(30)` 與 `MediaRecorder` 即時錄製，優先使用 `video/mp4`（H.264），不支援時改用 WebM。錄製期間在分頁可見時以 `requestAnimationFrame` 推進，隱藏時改用計時器避免停住。影片只在本機產生並經由 blob URL 下載，不上傳。

## IndexedDB

資料庫 `community-lottery-v1`，schema 版本 1：

| Store       | Key                 | 內容                                       |
| ----------- | ------------------- | ------------------------------------------ |
| activities  | 活動 UUID           | 貼文、狀態、游標、回覆待辦、目前規則及獎項 |
| comments    | 活動 UUID + 留言 ID | 首次觀察的原始留言                         |
| evaluations | 活動 UUID           | 最近保存的資格判定與籤池                   |
| draws       | 抽獎 UUID           | 當時完整深拷貝快照，使用 add，禁止覆寫     |

刪除活動以同一交易清除四個 stores 中該活動資料。更新擴充功能路徑或改變 extension ID 可能使原本的資料不再出現在新實例，重要結果請先匯出。

## 參考

- [原程式指定版本](https://github.com/Xunhaoz/Community-Lottery-Winners/blob/10715a0/main.py)
- [Chrome service worker 生命週期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Instaloader 的舊回覆分頁介面](https://github.com/instaloader/instaloader/blob/master/instaloader/structures.py)（只參考欄位与介面，沒有複製其實作）
