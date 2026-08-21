import { getSettings, onSettingsChange } from "./settings.js";

/**
 * Interface language. Deliberately separate from `settings.language`, which
 * is a free-typed instruction telling the AI what language to answer *in*
 * for filename suggestions — this only controls how Screenshotify's own UI
 * is worded.
 *
 * Static markup is translated declaratively via data-i18n* attributes,
 * applied on init and re-applied on every language change. Anything built at
 * runtime (toasts, list rows, status text) calls t() directly instead, so it
 * reads correctly the moment it's created regardless of current language.
 */

const PLURAL_SUFFIX = {
  en: (n) => (n === 1 ? "" : "s"),
  "zh-TW": () => "",
};

const en = {
  "titlebar.minimize": "Minimize",
  "titlebar.maximize": "Maximize",
  "titlebar.restore": "Restore Down",
  "titlebar.close": "Close",

  "sidebar.menu": "Menu",
  "sidebar.collapse": "Collapse sidebar",
  "sidebar.expand": "Expand sidebar",

  "tabs.review": "Review",
  "tabs.history": "History",
  "tabs.settings": "Settings",

  "watch.toggleTitle": "Toggle folder watching",
  "watch.noFolders": "No folders",
  "watch.watching": "Watching",
  "watch.paused": "Paused",
  "watch.tooltipOn": "Watching {count} folder{s} — click to pause",
  "watch.tooltipOff": "Click to resume watching",
  "watch.hintNoFolders": "No folders are being watched yet. Add one in Settings, or scan an existing folder below.",
  "watch.hintOn": "Screenshotify is watching your screenshot folders. Take a screenshot and a suggested name will show up here.",
  "watch.hintOff": "Watching is paused. Resume it from the button in the top-right, or scan a folder below.",
  "watch.needFolder": "Add a folder to watch first.",
  "watch.stoppedFatal": "Folder watching stopped: {message}",
  "watch.startFailed": "Could not start watching: {error}",

  "review.scanFolder": "Scan a folder…",
  "review.chooseFiles": "Choose files…",
  "review.retryFailed": "Retry failed",
  "review.clearList": "Clear list",
  "review.applyAll": "Apply all",
  "review.askingModel": "Asking the model… {done} of {total}",
  "review.cancel": "Cancel",
  "review.emptyTitle": "No screenshots waiting",
  "review.statusPending": "Queued",
  "review.statusWorking": "Asking the model…",
  "review.statusReady": "Suggested",
  "review.statusError": "Failed",
  "review.namePlaceholder": "Waiting for a suggestion…",
  "review.apply": "Apply",
  "review.skip": "Skip",
  "review.skipTitle": "Remove from the list without renaming",
  "review.retry": "Retry",
  "review.openFolder": "Open folder",
  "review.edited": "edited",
  "review.busy": "{count} in progress…",
  "review.listStatus": "{count} in list · {ready} ready",
  "review.emptyName": "That name is empty once the characters a filename cannot contain are removed.",
  "review.renamed": "Renamed.",
  "review.undo": "Undo",
  "review.undoAll": "Undo all",
  "review.appliedSome": "Renamed {count} file{s}, {failed} failed.",
  "review.appliedAll": "Renamed {count} file{s}.",
  "review.restoredCount": "Restored {count} original name{s}.",
  "review.openFolderFailed": "Could not open the folder: {error}",
  "review.previewFailed": "Could not open the preview: {error}",

  "dialog.bulkTitle": "That is a lot of images",
  "dialog.bulkMessage":
    "{count} images found.\n\nScreenshotify sends one request per image to {baseUrl}. On a paid endpoint that is {count} billable requests.\n\nQueue them all?",
  "dialog.bulkOk": "Queue them",
  "dialog.bulkCancel": "Cancel",
  "dialog.scanFolderTitle": "Choose a folder of screenshots to rename",
  "dialog.pickFilesTitle": "Choose screenshots to rename",
  "dialog.imagesFilter": "Images",
  "dialog.addFolderTitle": "Choose a folder to watch",

  "queue.emptyFolder": "No images found in that folder.",
  "queue.emptyFiles": "None of the selected files are images.",
  "queue.queuedAll": "Queued {count} image{s}.",
  "queue.queuedSome": "Queued {count} new image{s} ({already} already in the list).",
  "queue.scanFailed": "Could not read that folder: {error}",
  "queue.pickFailed": "Could not read those files: {error}",
  "queue.cancelled": "Cancelled",
  "queue.unusableName": "The model did not return a usable name.",

  "history.searchPlaceholder": "Search filenames…",
  "history.timeFilterTitle": "Filter by date",
  "history.rangeSummary": "{range} · {count} image{s}",
  "history.countSummary": "{count} image{s}",
  "history.timeAll": "All",
  "history.time7d": "7d",
  "history.time30d": "30d",
  "history.time90d": "90d",
  "history.time180d": "180d",
  "history.calPrevMonth": "Previous month",
  "history.calNextMonth": "Next month",
  "history.undoLastBatch": "Undo last batch",
  "history.clearHistory": "Clear history",
  "history.emptyTitleNone": "Nothing renamed yet",
  "history.emptyTitleFiltered": "No matching renames",
  "history.emptyHintNone": "Once you apply a suggestion it will be listed here so you can undo it.",
  "history.emptyHintFiltered": "Try a different search or filter.",
  "history.nothingToUndo": "Nothing left to undo.",
  "history.restoredPartial": "Restored {count}, {failed} could not be restored.",
  "history.restoredAll": "Restored {count} original name{s}.",
  "history.cleared": "History cleared. Files themselves are untouched.",
  "history.redone": "Renamed back to the suggested name.",
  "history.undone": "Original name restored.",
  "history.undoFailed": "Could not undo: {error}",
  "history.redoFailed": "Could not redo: {error}",
  "history.wasLabel": "was ",
  "history.undoBtn": "Undo",
  "history.redoBtn": "Redo",
  "history.justNow": "just now",
  "history.minAgo": "{n} min ago",
  "history.hourAgo": "{n} h ago",

  "toast.dismiss": "Dismiss",

  "settings.saved": "Setting saved.",

  "contextmenu.copyImage": "Copy image",
  "contextmenu.copied": "Image copied to the clipboard.",
  "contextmenu.copyFailed": "Could not copy the image: {error}",

  "settings.provider.title": "AI provider",
  "settings.provider.hint": "Any OpenAI-compatible endpoint that accepts image input: OpenAI, OpenRouter, Ollama, LM Studio, vLLM, and others. Your key is stored in the {keyStore}, never in plain text.",
  "settings.provider.noKeyLead": "Don't have a key yet?",
  "settings.provider.noKeyLink": "See where to get free AI access.",
  "settings.provider.baseUrl": "Base URL",
  "settings.provider.baseUrlHint": "Ollama: <code>http://localhost:11434/v1</code> · LM Studio: <code>http://localhost:1234/v1</code>",
  "settings.provider.apiKey": "API key",
  "settings.provider.remove": "Remove",
  "settings.provider.keyStatusStored": "A key is stored in the {keyStore}. Type a new one to replace it.",
  "settings.provider.keyStatusEmpty": "No key stored. Local endpoints such as Ollama usually do not need one.",
  "settings.provider.model": "Model",
  "settings.provider.loadModels": "Load models",
  "settings.provider.loading": "Loading…",
  "settings.provider.modelHint": "Free text — type any model name your endpoint accepts. It must support image input (e.g. <code>gpt-4o-mini</code>, <code>qwen2.5vl</code>, <code>llava</code>).",
  "settings.provider.testConnection": "Test connection",
  "settings.provider.testing": "Sending a small test image…",
  "settings.provider.testOk": 'Working. {model} accepted an image and replied: "{reply}"',
  "settings.provider.keySaved": "API key saved to the {keyStore}.",
  "settings.provider.keySaveFailed": "Could not save the key: {error}",
  "settings.provider.keyRemoved": "API key removed.",
  "settings.provider.keyRemoveFailed": "Could not remove the key: {error}",
  "settings.provider.modelsFound": "{count} models available — click the model box to pick one.",
  "settings.provider.modelsEmpty": "The endpoint returned no model list. Type the name yourself.",
  "settings.provider.modelsFailed": "Could not list models: {error}",

  "settings.usage.title": "Usage",
  "settings.usage.hint": "Every model Screenshotify has actually sent a request to, and how many tokens each one has used. Kept on this device only.",
  "settings.usage.requests": "requests",
  "settings.usage.inputTokens": "input tokens",
  "settings.usage.outputTokens": "output tokens",
  "settings.usage.empty": "No requests sent yet.",
  "settings.usage.reset": "Reset usage stats",
  "settings.usage.resetDone": "Usage stats reset.",
  "settings.usage.current": "Current",
  "settings.usage.req": "{n} req{s}",
  "settings.usage.in": "{n} in",
  "settings.usage.out": "{n} out",

  "settings.folders.title": "Watched folders",
  "settings.folders.hint": "New image files in these folders are picked up automatically. Subfolders are included.",
  "settings.folders.empty": "No folders yet — nothing is being watched.",
  "settings.folders.add": "Add folder…",
  "settings.folders.addDefault": "Use default Screenshots folder",
  "settings.folders.open": "Open",
  "settings.folders.remove": "Remove",
  "settings.folders.alreadyWatching": "That folder is already being watched.",
  "settings.folders.noDefault": "No standard screenshot folder was found on this PC.",
  "settings.folders.alreadyListed": "Those folders are already in the list.",

  "settings.naming.title": "Naming",
  "settings.naming.filenameStyle": "Filename style",
  "settings.naming.styleKebab": "kebab-case — my-screenshot",
  "settings.naming.styleSnake": "snake_case — my_screenshot",
  "settings.naming.styleSpace": "Spaces — my screenshot",
  "settings.naming.styleTitle": "Title Case — My Screenshot",
  "settings.naming.styleCamel": "camelCase — myScreenshot",
  "settings.naming.datePrefix": "Date prefix",
  "settings.naming.dateNone": "None",
  "settings.naming.dateHint": "Uses the file's creation time, not today's date.",
  "settings.naming.maxWords": "Maximum words",
  "settings.naming.words": "words",
  "settings.naming.language": "Description language",
  "settings.naming.promptExtra": "Extra instructions for the model (optional)",
  "settings.naming.promptExtraPlaceholder": "e.g. Always mention the app or website name if it is visible.",

  "settings.behaviour.title": "Behaviour",
  "settings.behaviour.uiLanguage": "Interface language",
  "settings.behaviour.photosPerRow": "Photos per row",
  "settings.behaviour.photosPerRowList": "1 — list",
  "settings.behaviour.photosPerRowHint": "Applies to both the Review and History lists.",
  "settings.behaviour.watchEnabled": "Watch folders for new screenshots",
  "settings.behaviour.notifications": "Show a notification when a suggestion is ready",
  "settings.behaviour.notificationsHint": "Click the notification to open the review panel.",
  "settings.behaviour.autostart": "Start Screenshotify when I {loginPhrase}",
  "settings.behaviour.startMinimized": "Start hidden in the {trayName}",
  "settings.behaviour.closeToTray": "Closing the window hides it to the {trayName} instead of quitting",
  "settings.behaviour.concurrency": "Parallel requests",
  "settings.behaviour.concurrencyHint": "Lower this if your provider rate-limits you.",
  "settings.behaviour.maxEdge": "Image sent to the model",
  "settings.behaviour.maxEdgeSuffix": "px longest edge",
  "settings.behaviour.maxEdgeHint": "Screenshots are downscaled before upload to cut cost and latency. Raise this if small text in your screenshots matters.",
  "settings.behaviour.startupFailed": "Could not change the startup setting: {error}",

  "settings.updates.title": "Updates",
  "settings.updates.autoCheck": "Check for updates automatically on launch",
  "settings.updates.checkNow": "Check for updates now",
  "settings.updates.checking": "Checking…",
  "settings.updates.upToDate": "You are on the latest version.",
  "settings.updates.upToDateToast": "Screenshotify is up to date.",
  "settings.updates.available": "Version {version} available.",
  "settings.updates.availableToast": "Screenshotify {version} is available.",
  "settings.updates.install": "Install and restart",
  "settings.updates.downloading": "Downloading…",
  "settings.updates.downloadingPct": "Downloading… {pct}%",
  "settings.updates.installing": "Installing…",
  "settings.updates.failed": "Update failed: {error}",
  "settings.updates.checkFailed": "Update check failed: {error}",
  "settings.updates.footerSuffix": "· MIT licensed",
  "settings.updates.starOnGithub": "Star on GitHub",

  "app.startFailed": "Screenshotify failed to start.",
};

const zhTW = {
  "titlebar.minimize": "最小化",
  "titlebar.maximize": "最大化",
  "titlebar.restore": "還原視窗大小",
  "titlebar.close": "關閉",

  "sidebar.menu": "選單",
  "sidebar.collapse": "收合側邊欄",
  "sidebar.expand": "展開側邊欄",

  "tabs.review": "審核",
  "tabs.history": "歷史紀錄",
  "tabs.settings": "設定",

  "watch.toggleTitle": "切換資料夾監控",
  "watch.noFolders": "無資料夾",
  "watch.watching": "監控中",
  "watch.paused": "已暫停",
  "watch.tooltipOn": "正在監控 {count} 個資料夾 — 點擊以暫停",
  "watch.tooltipOff": "點擊以繼續監控",
  "watch.hintNoFolders": "尚未監控任何資料夾。請在設定中新增一個，或在下方掃描現有的資料夾。",
  "watch.hintOn": "Screenshotify 正在監控你的螢幕截圖資料夾。截圖後，建議的檔名會顯示在這裡。",
  "watch.hintOff": "監控已暫停。可從右上角的按鈕繼續，或在下方掃描資料夾。",
  "watch.needFolder": "請先新增要監控的資料夾。",
  "watch.stoppedFatal": "資料夾監控已停止：{message}",
  "watch.startFailed": "無法開始監控：{error}",

  "review.scanFolder": "掃描資料夾…",
  "review.chooseFiles": "選擇檔案…",
  "review.retryFailed": "重試失敗項目",
  "review.clearList": "清空清單",
  "review.applyAll": "套用全部",
  "review.askingModel": "詢問模型中… {done} / {total}",
  "review.cancel": "取消",
  "review.emptyTitle": "目前沒有等待中的螢幕截圖",
  "review.statusPending": "已加入佇列",
  "review.statusWorking": "詢問模型中…",
  "review.statusReady": "已建議",
  "review.statusError": "失敗",
  "review.namePlaceholder": "等待建議中…",
  "review.apply": "套用",
  "review.skip": "略過",
  "review.skipTitle": "從清單中移除，不進行重新命名",
  "review.retry": "重試",
  "review.openFolder": "開啟資料夾",
  "review.edited": "已編輯",
  "review.busy": "{count} 項處理中…",
  "review.listStatus": "清單中共 {count} 項 · {ready} 項就緒",
  "review.emptyName": "移除檔名不可使用的字元後，名稱變成空白了。",
  "review.renamed": "已重新命名。",
  "review.undo": "復原",
  "review.undoAll": "全部復原",
  "review.appliedSome": "已重新命名 {count} 個檔案，{failed} 個失敗。",
  "review.appliedAll": "已重新命名 {count} 個檔案。",
  "review.restoredCount": "已還原 {count} 個原始檔名。",
  "review.openFolderFailed": "無法開啟資料夾：{error}",
  "review.previewFailed": "無法開啟預覽：{error}",

  "dialog.bulkTitle": "圖片數量很多",
  "dialog.bulkMessage":
    "找到 {count} 張圖片。\n\nScreenshotify 會對 {baseUrl} 的每張圖片各發出一次請求。若使用付費方案，這相當於 {count} 次計費請求。\n\n要將它們全部加入佇列嗎？",
  "dialog.bulkOk": "加入佇列",
  "dialog.bulkCancel": "取消",
  "dialog.scanFolderTitle": "選擇要重新命名螢幕截圖的資料夾",
  "dialog.pickFilesTitle": "選擇要重新命名的螢幕截圖",
  "dialog.imagesFilter": "圖片",
  "dialog.addFolderTitle": "選擇要監控的資料夾",

  "queue.emptyFolder": "該資料夾中沒有找到圖片。",
  "queue.emptyFiles": "所選的檔案都不是圖片。",
  "queue.queuedAll": "已將 {count} 張圖片加入佇列。",
  "queue.queuedSome": "已將 {count} 張新圖片加入佇列（另有 {already} 張已在清單中）。",
  "queue.scanFailed": "無法讀取該資料夾：{error}",
  "queue.pickFailed": "無法讀取所選的檔案：{error}",
  "queue.cancelled": "已取消",
  "queue.unusableName": "模型未回傳可用的名稱。",

  "history.searchPlaceholder": "搜尋檔名…",
  "history.timeFilterTitle": "依日期篩選",
  "history.rangeSummary": "{range} · 共 {count} 張",
  "history.countSummary": "共 {count} 張",
  "history.timeAll": "全部",
  "history.time7d": "7天",
  "history.time30d": "30天",
  "history.time90d": "90天",
  "history.time180d": "180天",
  "history.calPrevMonth": "上個月",
  "history.calNextMonth": "下個月",
  "history.undoLastBatch": "復原最近一批",
  "history.clearHistory": "清除歷史紀錄",
  "history.emptyTitleNone": "尚未重新命名任何檔案",
  "history.emptyTitleFiltered": "沒有符合的紀錄",
  "history.emptyHintNone": "套用建議後會顯示在這裡，方便你之後復原。",
  "history.emptyHintFiltered": "試試不同的搜尋條件或篩選器。",
  "history.nothingToUndo": "沒有可復原的項目了。",
  "history.restoredPartial": "已還原 {count} 個，{failed} 個無法還原。",
  "history.restoredAll": "已還原 {count} 個原始檔名。",
  "history.cleared": "歷史紀錄已清除。檔案本身未受影響。",
  "history.redone": "已重新套用建議的檔名。",
  "history.undone": "已還原原始檔名。",
  "history.undoFailed": "無法復原：{error}",
  "history.redoFailed": "無法重新套用：{error}",
  "history.wasLabel": "原本是：",
  "history.undoBtn": "復原",
  "history.redoBtn": "重做",
  "history.justNow": "剛剛",
  "history.minAgo": "{n} 分鐘前",
  "history.hourAgo": "{n} 小時前",

  "toast.dismiss": "關閉",

  "settings.saved": "設定已儲存。",

  "contextmenu.copyImage": "複製圖片",
  "contextmenu.copied": "圖片已複製到剪貼簿。",
  "contextmenu.copyFailed": "無法複製圖片：{error}",

  "settings.provider.title": "AI 提供者",
  "settings.provider.hint": "任何支援圖片輸入、與 OpenAI 相容的端點：OpenAI、OpenRouter、Ollama、LM Studio、vLLM 等。你的金鑰會儲存在{keyStore}中，絕不會以明文儲存。",
  "settings.provider.noKeyLead": "還沒有金鑰嗎？",
  "settings.provider.noKeyLink": "查看如何取得免費的 AI 存取權限。",
  "settings.provider.baseUrl": "調用基礎網址（Base URL）",
  "settings.provider.baseUrlHint": "Ollama：<code>http://localhost:11434/v1</code> · LM Studio：<code>http://localhost:1234/v1</code>",
  "settings.provider.apiKey": "API 金鑰",
  "settings.provider.remove": "移除",
  "settings.provider.keyStatusStored": "已將金鑰儲存在{keyStore}中。輸入新金鑰即可取代它。",
  "settings.provider.keyStatusEmpty": "尚未儲存金鑰。像 Ollama 這類本機端點通常不需要金鑰。",
  "settings.provider.model": "模型",
  "settings.provider.loadModels": "載入模型清單",
  "settings.provider.loading": "載入中…",
  "settings.provider.modelHint": "自由輸入 — 可輸入端點支援的任何模型名稱，但必須支援圖片輸入（例如 <code>gpt-4o-mini</code>、<code>qwen2.5vl</code>、<code>llava</code>）。",
  "settings.provider.testConnection": "測試連線",
  "settings.provider.testing": "正在傳送小型測試圖片…",
  "settings.provider.testOk": "連線成功。{model} 接受了圖片並回覆：「{reply}」",
  "settings.provider.keySaved": "API 金鑰已儲存到{keyStore}。",
  "settings.provider.keySaveFailed": "無法儲存金鑰：{error}",
  "settings.provider.keyRemoved": "API 金鑰已移除。",
  "settings.provider.keyRemoveFailed": "無法移除金鑰：{error}",
  "settings.provider.modelsFound": "找到 {count} 個可用模型 — 點擊模型欄位即可選擇。",
  "settings.provider.modelsEmpty": "該端點未回傳模型清單，請自行輸入名稱。",
  "settings.provider.modelsFailed": "無法列出模型：{error}",

  "settings.usage.title": "用量",
  "settings.usage.hint": "記錄 Screenshotify 實際發出過請求的每個模型，以及各自使用的權杖（token）數量。僅保存在本機。",
  "settings.usage.requests": "次請求",
  "settings.usage.inputTokens": "個輸入權杖",
  "settings.usage.outputTokens": "個輸出權杖",
  "settings.usage.empty": "尚未發出任何請求。",
  "settings.usage.reset": "重設用量統計",
  "settings.usage.resetDone": "用量統計已重設。",
  "settings.usage.current": "目前使用中",
  "settings.usage.req": "{n} 次請求",
  "settings.usage.in": "{n} 輸入",
  "settings.usage.out": "{n} 輸出",

  "settings.folders.title": "監控中的資料夾",
  "settings.folders.hint": "這些資料夾中的新圖片檔案會自動被偵測，包含子資料夾。",
  "settings.folders.empty": "尚未加入任何資料夾 — 目前沒有監控任何項目。",
  "settings.folders.add": "新增資料夾…",
  "settings.folders.addDefault": "使用預設的螢幕截圖資料夾",
  "settings.folders.open": "開啟",
  "settings.folders.remove": "移除",
  "settings.folders.alreadyWatching": "該資料夾已在監控中。",
  "settings.folders.noDefault": "在此電腦上找不到標準的螢幕截圖資料夾。",
  "settings.folders.alreadyListed": "這些資料夾已在清單中。",

  "settings.naming.title": "命名",
  "settings.naming.filenameStyle": "檔名樣式",
  "settings.naming.styleKebab": "kebab-case — my-screenshot",
  "settings.naming.styleSnake": "snake_case — my_screenshot",
  "settings.naming.styleSpace": "空格分隔 — my screenshot",
  "settings.naming.styleTitle": "字首大寫 — My Screenshot",
  "settings.naming.styleCamel": "camelCase — myScreenshot",
  "settings.naming.datePrefix": "日期前綴",
  "settings.naming.dateNone": "無",
  "settings.naming.dateHint": "使用檔案的建立時間，而非今天的日期。",
  "settings.naming.maxWords": "最多字數",
  "settings.naming.words": "個字",
  "settings.naming.language": "描述語言",
  "settings.naming.promptExtra": "給模型的額外指示（選填）",
  "settings.naming.promptExtraPlaceholder": "例如：畫面中若能看到應用程式或網站名稱，一律標明。",

  "settings.behaviour.title": "行為",
  "settings.behaviour.uiLanguage": "介面語言",
  "settings.behaviour.photosPerRow": "每列顯示張數",
  "settings.behaviour.photosPerRowList": "1 — 清單檢視",
  "settings.behaviour.photosPerRowHint": "同時套用於「審核」與「歷史紀錄」清單。",
  "settings.behaviour.watchEnabled": "監控資料夾中的新螢幕截圖",
  "settings.behaviour.notifications": "建議就緒時顯示通知",
  "settings.behaviour.notificationsHint": "點擊通知即可開啟審核面板。",
  "settings.behaviour.autostart": "{loginPhrase}時自動啟動 Screenshotify",
  "settings.behaviour.startMinimized": "啟動時隱藏於{trayName}",
  "settings.behaviour.closeToTray": "關閉視窗時會隱藏到{trayName}，而不是結束程式",
  "settings.behaviour.concurrency": "平行請求數",
  "settings.behaviour.concurrencyHint": "若你的服務商有速率限制，可調低此數值。",
  "settings.behaviour.maxEdge": "傳送給模型的圖片",
  "settings.behaviour.maxEdgeSuffix": "像素（最長邊）",
  "settings.behaviour.maxEdgeHint": "螢幕截圖上傳前會先縮小以降低成本與延遲。若截圖中的小字很重要，可調高此數值。",
  "settings.behaviour.startupFailed": "無法變更啟動設定：{error}",

  "settings.updates.title": "更新",
  "settings.updates.autoCheck": "啟動時自動檢查更新",
  "settings.updates.checkNow": "立即檢查更新",
  "settings.updates.checking": "檢查中…",
  "settings.updates.upToDate": "目前已是最新版本。",
  "settings.updates.upToDateToast": "Screenshotify 已是最新版本。",
  "settings.updates.available": "有可用的新版本 {version}。",
  "settings.updates.availableToast": "Screenshotify {version} 已可更新。",
  "settings.updates.install": "安裝並重新啟動",
  "settings.updates.downloading": "下載中…",
  "settings.updates.downloadingPct": "下載中… {pct}%",
  "settings.updates.installing": "安裝中…",
  "settings.updates.failed": "更新失敗：{error}",
  "settings.updates.checkFailed": "檢查更新失敗：{error}",
  "settings.updates.footerSuffix": "· MIT 授權",
  "settings.updates.starOnGithub": "在 GitHub 上給個⭐",

  "app.startFailed": "Screenshotify 啟動失敗。",
};

const dict = { en, "zh-TW": zhTW };
const SUPPORTED = new Set(Object.keys(dict));

let current = "en";
const listeners = new Set();

function normalize(v) {
  return SUPPORTED.has(v) ? v : "en";
}

export function currentLocale() {
  return current;
}

/** BCP-47 tag for Intl/toLocale* calls elsewhere in the app. */
export function localeTag() {
  return current === "zh-TW" ? "zh-TW" : "en-US";
}

export function t(key, vars) {
  const table = dict[current] || dict.en;
  let str = table[key];
  if (str == null) str = dict.en[key];
  if (str == null) return key;

  const merged = vars ? { ...vars } : {};
  if (merged.count != null && merged.s == null) {
    merged.s = (PLURAL_SUFFIX[current] || PLURAL_SUFFIX.en)(merged.count);
  }
  return str.replace(/\{(\w+)\}/g, (_, k) => (merged[k] != null ? String(merged[k]) : `{${k}}`));
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function applyStaticDom() {
  document.documentElement.lang = current === "zh-TW" ? "zh-Hant-TW" : "en";

  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-html]")) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of document.querySelectorAll("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  }
}

function setLocale(next) {
  const normalized = normalize(next);
  if (normalized === current) return;
  current = normalized;
  applyStaticDom();
  for (const fn of listeners) {
    try {
      fn(current);
    } catch (err) {
      console.error("locale listener failed", err);
    }
  }
}

export function initI18n() {
  current = normalize(getSettings().uiLanguage);
  applyStaticDom();
  onSettingsChange((s) => setLocale(s.uiLanguage));
}
