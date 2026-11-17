// ExManga Harvester Studio v1.9 — Фоновый сервис (Manifest V3 Service Worker)

const DEFAULT_SETTINGS = {
  saveMode: "folder",                   // "folder" | "cbz" | "zip"
  quality: "webp",                      // "webp" | "original"
  delayMs: 1200,                        // Целевой интервал между запросами к API (мс)
  maxRetries: 3,                        // Попытки смены зеркала через ?nl=...
  folderTemplate: "{title}",            // "{title}" | "[{gid}] {title}" | "Manga/{title}"
  fileTemplate: "{page_pad}_{orig_name}", // "{page_pad}" | "{page_pad}_{orig_name}"
  smartResume: true,                    // Пропускать уже скачанные файлы в папке
  includeComicInfo: true,               // Добавлять ComicInfo.xml с метаданными и тегами
  fallbackOriginal: true                // Авто-фоллбэк на WebP при лимите GP/509 у fullimg
};

const TARGET_URL_PATTERNS = [
  "*://exhentai.org/g/*",
  "*://exhentai.org/s/*",
  "*://*.exhentai.org/g/*",
  "*://*.exhentai.org/s/*",
  "*://e-hentai.org/g/*",
  "*://e-hentai.org/s/*",
  "*://*.e-hentai.org/g/*",
  "*://*.e-hentai.org/s/*"
];

async function getLastDownloadId() {
  try {
    if (chrome.storage.session) {
      const res = await chrome.storage.session.get(["lastHarvesterDownloadId"]);
      if (res && typeof res.lastHarvesterDownloadId === "number") {
        return res.lastHarvesterDownloadId;
      }
    }
    const localRes = await chrome.storage.local.get(["lastHarvesterDownloadId"]);
    return typeof localRes?.lastHarvesterDownloadId === "number"
      ? localRes.lastHarvesterDownloadId
      : null;
  } catch {
    return null;
  }
}

async function setLastDownloadId(downloadId) {
  if (typeof downloadId !== "number") return;
  try {
    if (chrome.storage.session) {
      await chrome.storage.session.set({ lastHarvesterDownloadId: downloadId });
    }
    await chrome.storage.local.set({ lastHarvesterDownloadId: downloadId });
  } catch {
    // ignore storage errors
  }
}

// Автоматическое переподключение content.js во всех открытых вкладках ExHentai/E-Hentai
// после обновления или перезагрузки расширения в chrome://extensions (лечит "Extension context invalidated")
async function reinjectOpenGalleryTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: TARGET_URL_PATTERNS });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["styles.css"]
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"]
        });
      } catch {
        // Вкладка ещё грузится или недоступна
      }
    }
  } catch {
    // ignore
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const res = await chrome.storage.local.get(["harvesterSettings"]);
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(res?.harvesterSettings || {})
  };
  await chrome.storage.local.set({ harvesterSettings: merged });
  await reinjectOpenGalleryTabs();
});

async function fetchWithFallback(url, includeCreds) {
  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: includeCreds ? "include" : "omit",
      cache: "no-store",
      redirect: "follow"
    });
    if (res.ok) return res;
    if (includeCreds) {
      const retryRes = await fetch(url, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "follow"
      });
      if (retryRes.ok) return retryRes;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    if (includeCreds) {
      const retryRes = await fetch(url, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "follow"
      });
      if (retryRes.ok) return retryRes;
    }
    throw err;
  }
}

function uint8ToBase64(bytes) {
  const chunk = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
  }
  return btoa(parts.join(""));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return false;

  if (msg.action === "fetchImageBytes") {
    const includeCreds = Boolean(msg.includeCredentials);
    fetchWithFallback(msg.url, includeCreds)
      .then(async (res) => {
        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        if (contentType.includes("text/html") || contentType.includes("text/plain")) {
          const previewText = (await res.text()).slice(0, 600);
          const isQuotaOrLimit =
            /requires GP|bandwidth|limit|509|exceeded|insufficient|temporarily unavailable/i.test(
              previewText
            );
          const reason = isQuotaOrLimit
            ? `Лимит сервера/GP для оригинала (${previewText.replace(/<[^>]+>/g, " ").trim().slice(0, 90)})`
            : "Сервер вернул текст/HTML вместо изображения (сбой ноды H@H)";
          sendResponse({
            ok: false,
            isQuotaOrLimit,
            error: reason
          });
          return;
        }

        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (bytes.length < 128) {
          sendResponse({
            ok: false,
            isQuotaOrLimit: false,
            error: "Пустой или повреждённый ответ узла CDN (< 128 байт)"
          });
          return;
        }

        sendResponse({
          ok: true,
          base64: uint8ToBase64(bytes),
          size: bytes.length,
          contentType: contentType || "image/webp",
          finalUrl: res.url || msg.url
        });
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          isQuotaOrLimit: false,
          error: err && err.message ? err.message : String(err)
        });
      });
    return true;
  }

  // Скачивание архива через chrome.downloads с точным запоминанием его downloadId
  if (msg.action === "downloadArchiveBlobUrl") {
    chrome.downloads.download(
      {
        url: msg.blobUrl,
        filename: msg.filename || "Manga.cbz",
        conflictAction: "uniquify",
        saveAs: false
      },
      async (downloadId) => {
        if (chrome.runtime.lastError || typeof downloadId !== "number") {
          sendResponse({
            ok: false,
            error: chrome.runtime.lastError?.message || "Не удалось сохранить архив через браузер"
          });
          return;
        }
        await setLastDownloadId(downloadId);
        sendResponse({ ok: true, downloadId });
      }
    );
    return true;
  }

  // Открытие папки со скачанной мангой в Проводнике Windows
  if (msg.action === "openDownloadsFolder") {
    (async () => {
      const lastId = await getLastDownloadId();
      if (msg.preferShowLastFile && lastId !== null) {
        chrome.downloads.search({ id: lastId }, (items) => {
          if (items && items.length > 0 && items[0].exists !== false) {
            chrome.downloads.show(lastId);
            sendResponse({ ok: true, mode: "show_item" });
          } else {
            chrome.downloads.showDefaultFolder();
            sendResponse({ ok: true, mode: "default_folder" });
          }
        });
        return;
      }

      chrome.downloads.showDefaultFolder();
      sendResponse({ ok: true, mode: "default_folder" });
    })();
    return true;
  }

  return false;
});
