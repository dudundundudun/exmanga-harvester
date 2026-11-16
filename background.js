// ExManga Harvester Studio v1.8 — Фоновый сервис (Manifest V3 Service Worker)

const DEFAULT_SETTINGS = {
  saveMode: "folder",       // "folder" | "cbz" | "zip"
  quality: "webp",          // "webp" | "original"
  delayMs: 1200,            // Пауза между запросами к API (мс)
  maxRetries: 3,            // Попытки смены зеркала через ?nl=...
  folderTemplate: "{title}", // "{title}" | "[{gid}] {title}" | "Manga/{title}"
  fileTemplate: "{page_pad}_{orig_name}" // "{page_pad}" | "{page_pad}_{orig_name}"
};

const pendingPathsById = new Map();
const pendingPathsByUrl = new Map();
let lastCompletedDownloadId = null;

function sanitizeRelativePath(rawPath) {
  const parts = String(rawPath || "Manga/page.webp")
    .replace(/\\/g, "/")
    .split("/")
    .map((segment, idx, arr) => {
      const isLast = idx === arr.length - 1;
      let clean = segment
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
      return clean || (isLast ? "page.webp" : "Manga");
    })
    .filter(Boolean);

  return parts.join("/");
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["harvesterSettings"], (res) => {
    if (!res || !res.harvesterSettings) {
      chrome.storage.local.set({ harvesterSettings: DEFAULT_SETTINGS });
    }
  });
});

// Запоминаем ID последнего скачанного файла/архива, чтобы кнопка «Открыть папку» могла подсветить его в Проводнике
chrome.downloads.onCreated.addListener((item) => {
  if (item && item.id) {
    lastCompletedDownloadId = item.id;
  }
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item && item.id) {
    lastCompletedDownloadId = item.id;
  }
  let targetPath = pendingPathsById.get(item.id);
  if (!targetPath && item.url) {
    targetPath = pendingPathsByUrl.get(item.url);
  }
  if (targetPath) {
    pendingPathsById.delete(item.id);
    if (item.url) pendingPathsByUrl.delete(item.url);
    suggest({
      filename: targetPath,
      conflictAction: "uniquify"
    });
    return;
  }
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return false;

  if (msg.action === "fetchImageBytes") {
    const includeCreds = Boolean(msg.includeCredentials);
    fetchWithFallback(msg.url, includeCreds)
      .then(async (res) => {
        const contentType = (res.headers.get("content-type") || "").toLowerCase();
        if (contentType.includes("text/html")) {
          throw new Error("Сервер вернул HTML вместо изображения (возможно, лимит или ошибка узла)");
        }
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        if (bytes.length < 128) {
          throw new Error("Пустой или повреждённый ответ узла CDN");
        }
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        sendResponse({
          ok: true,
          base64: btoa(binary),
          size: bytes.length,
          contentType: contentType || "image/webp",
          finalUrl: res.url || msg.url
        });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      });
    return true;
  }

  if (msg.action === "downloadSingleFile") {
    const safeFilename = sanitizeRelativePath(msg.filename || "Manga/page.webp");
    pendingPathsByUrl.set(msg.url, safeFilename);

    chrome.downloads.download(
      {
        url: msg.url,
        filename: safeFilename,
        conflictAction: "uniquify",
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          pendingPathsByUrl.delete(msg.url);
          sendResponse({
            ok: false,
            error: chrome.runtime.lastError?.message || "Не удалось запустить загрузку"
          });
        } else {
          lastCompletedDownloadId = downloadId;
          pendingPathsById.set(downloadId, safeFilename);
          setTimeout(() => {
            pendingPathsById.delete(downloadId);
            pendingPathsByUrl.delete(msg.url);
          }, 60000);
          sendResponse({ ok: true, downloadId, filename: safeFilename });
        }
      }
    );
    return true;
  }

  // Открытие папки со скачанной мангой в Проводнике Windows
  if (msg.action === "openDownloadsFolder") {
    if (msg.preferShowLastFile && lastCompletedDownloadId !== null) {
      chrome.downloads.search({ id: lastCompletedDownloadId }, (items) => {
        if (items && items.length > 0 && items[0].exists !== false) {
          chrome.downloads.show(lastCompletedDownloadId);
          sendResponse({ ok: true, mode: "show_item" });
        } else {
          chrome.downloads.showDefaultFolder();
          sendResponse({ ok: true, mode: "default_folder" });
        }
      });
      return true;
    }

    chrome.downloads.showDefaultFolder();
    sendResponse({ ok: true, mode: "default_folder" });
    return true;
  }

  return false;
});
