// ExManga Harvester Studio v2.0 — Фоновый сервис (Manifest V3 Service Worker)

const DEFAULT_SETTINGS = {
  saveMode: "folder",                     // "folder" | "cbz" | "zip"
  quality: "webp",                        // "webp" | "original"
  delayMs: 1200,                          // Целевой интервал между запросами к API (мс)
  maxRetries: 3,                          // Попытки смены зеркала через ?nl=...
  folderTemplate: "{title}",              // "{title}" | "[{gid}] {title}" | "Manga/{title}"
  fileTemplate: "{page_pad}_{orig_name}", // "{page_pad}" | "{page_pad}_{orig_name}"
  smartResume: true,                      // Пропускать уже скачанные файлы в папке
  includeComicInfo: true,                 // Добавлять ComicInfo.xml с метаданными и тегами
  fallbackOriginal: true                  // Авто-фоллбэк на WebP при лимите GP/509 у fullimg
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

const TRUSTED_CREDENTIAL_HOST_RE = /(^|\.)(exhentai|e-hentai)\.org$/i;
const IMAGE_FETCH_TIMEOUT_MS = 25000;

function isAllowedHttpUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function canSendCredentialsTo(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    return TRUSTED_CREDENTIAL_HOST_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

function sanitizeDownloadRelativePath(rawPath) {
  return String(rawPath || "Manga/ComicInfo.xml")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part, idx, arr) => {
      const isLast = idx === arr.length - 1;
      let clean = part
        .replace(/[\\/:*?"<>|~\x00-\x1f]/g, "_")
        .replace(/\s+/g, " ")
        .trim();
      if (!isLast) {
        clean = clean.replace(/^[. ]+|[. ]+$/g, "");
      } else {
        clean = clean.replace(/^[. ]+/, "");
      }
      if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(clean)) {
        clean = `_${clean}`;
      }
      return clean || (isLast ? "ComicInfo.xml" : "Manga");
    })
    .filter(Boolean)
    .join("/");
}

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

function downloadUrlAndWait(url, rawFilename, conflictAction = "overwrite", timeoutMs = 60000) {
  const filename = sanitizeDownloadRelativePath(rawFilename);
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url,
        filename,
        conflictAction,
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError || typeof downloadId !== "number") {
          resolve({
            ok: false,
            error: chrome.runtime.lastError?.message || "Не удалось создать задачу загрузки"
          });
          return;
        }

        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          chrome.downloads.onChanged.removeListener(onChanged);
          clearTimeout(timer);
          resolve(result);
        };

        const onChanged = (delta) => {
          if (delta.id !== downloadId) return;
          if (delta.state && delta.state.current === "complete") {
            finish({ ok: true, downloadId, filename });
          } else if (delta.state && delta.state.current === "interrupted") {
            finish({ ok: false, downloadId, error: "Загрузка прервана" });
          }
        };

        chrome.downloads.onChanged.addListener(onChanged);

        chrome.downloads.search({ id: downloadId }, (items) => {
          if (items && items[0]) {
            if (items[0].state === "complete") {
              finish({ ok: true, downloadId, filename, fullPath: items[0].filename });
            } else if (items[0].state === "interrupted") {
              finish({ ok: false, downloadId, error: "Загрузка прервана" });
            }
          }
        });

        const timer = setTimeout(() => {
          finish({ ok: false, downloadId, error: "Таймаут ожидания записи файла" });
        }, timeoutMs);
      }
    );
  });
}

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
          files: ["zip_builder.js", "parser.js", "content.js"]
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

async function fetchOnceWithTimeout(url, credentialsMode, timeoutMs = IMAGE_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      credentials: credentialsMode,
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Таймаут загрузки изображения (${Math.round(timeoutMs / 1000)} с)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithFallback(url, includeCreds) {
  const allowCreds = Boolean(includeCreds && canSendCredentialsTo(url));
  try {
    const res = await fetchOnceWithTimeout(url, allowCreds ? "include" : "omit");
    if (res.ok) return res;
    if (allowCreds) {
      const retryRes = await fetchOnceWithTimeout(url, "omit");
      if (retryRes.ok) return retryRes;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    if (allowCreds) {
      const retryRes = await fetchOnceWithTimeout(url, "omit");
      if (retryRes.ok) return retryRes;
    }
    throw err;
  }
}

function uint8ToBase64(bytes) {
  const chunk = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    let str = "";
    for (let j = 0; j < slice.length; j++) {
      str += String.fromCharCode(slice[j]);
    }
    parts.push(str);
  }
  return btoa(parts.join(""));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!msg || !msg.action) return false;

  if (msg.action === "fetchImageBytes") {
    if (!isAllowedHttpUrl(msg.url)) {
      sendResponse({
        ok: false,
        isQuotaOrLimit: false,
        error: "Недопустимый URL изображения (разрешены только http/https)"
      });
      return false;
    }

    const includeCreds = Boolean(msg.includeCredentials);
    fetchWithFallback(msg.url, includeCreds)
      .then(async (res) => {
        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        const isBinaryImage =
          !contentType ||
          contentType.startsWith("image/") ||
          contentType.includes("application/octet-stream");

        if (!isBinaryImage) {
          const previewText = (await res.text()).slice(0, 600);
          const isQuotaOrLimit =
            /requires GP|bandwidth|limit|509|exceeded|insufficient|temporarily unavailable/i.test(
              previewText
            );
          const reason = isQuotaOrLimit
            ? `Лимит сервера/GP для оригинала (${previewText.replace(/<[^>]+>/g, " ").trim().slice(0, 90)})`
            : `Сервер вернул ${contentType.split(";")[0] || "не-изображение"} вместо картинки (сбой ноды H@H)`;
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
    (async () => {
      const res = await downloadUrlAndWait(
        msg.blobUrl,
        msg.filename || "Manga.cbz",
        "uniquify",
        60000
      );
      if (res.ok && typeof res.downloadId === "number") {
        await setLastDownloadId(res.downloadId);
      }
      sendResponse(res);
    })();
    return true;
  }

  // Открытие конкретного downloadId в настоящем Проводнике Windows (explorer.exe /select,...)
  if (msg.action === "showDownloadIdInExplorer") {
    const targetId = typeof msg.downloadId === "number" ? msg.downloadId : null;
    (async () => {
      const idToShow = targetId !== null ? targetId : await getLastDownloadId();
      if (idToShow !== null) {
        chrome.downloads.search({ id: idToShow }, (items) => {
          if (items && items.length > 0 && items[0].exists !== false) {
            chrome.downloads.show(idToShow);
            sendResponse({ ok: true, mode: "show_item", downloadId: idToShow });
          } else {
            sendResponse({ ok: false, error: "Файл не найден в истории загрузок Chrome" });
          }
        });
        return;
      }
      sendResponse({ ok: false, error: "Нет привязанного downloadId" });
    })();
    return true;
  }

  // Фоллбэк: открытие папки в Проводнике Windows
  if (msg.action === "openDownloadsFolder") {
    (async () => {
      const lastId = await getLastDownloadId();
      if (lastId !== null) {
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
