(() => {
  // Если в этой вкладке уже работал старый экземпляр скрипта (до перезагрузки расширения в chrome://extensions),
  // посылаем ему сигнал завершения и заменяем панель на живую.
  window.dispatchEvent(new CustomEvent("mhs:teardown-previous-instance"));

  const ZIP = globalThis.MHS_ZIP;
  const PARSER = globalThis.MHS_PARSER;
  if (!ZIP || !PARSER) {
    console.error("[ExManga Harvester] Не загружены модули zip_builder.js / parser.js");
    return;
  }

  const { buildZipBlob, buildComicInfoXml } = ZIP;
  const {
    sanitizeName,
    buildFolderPath,
    parseGalleryTags,
    computeGalleryPagination,
    detectPageMetadata: detectMetaWithMode,
    parseReaderFragments,
    parseFullReaderDocument,
    findReaderLinkInGalleryDoc,
    extractOriginalBaseName,
    formatEntryName
  } = PARSER;

  let instanceAborted = false;

  const NETWORK_TIMEOUT_MS = 20000;
  const API_MAX_RETRIES = 3;
  const MAX_ARCHIVE_PART_BYTES = 450 * 1024 * 1024; // 450 МБ на один том CBZ/ZIP (защита от OOM)

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function base64ToUint8Array(base64) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`Таймаут сетевого запроса (${Math.round(timeoutMs / 1000)} с)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // === Проверка валидности контекста расширения (защита от "Extension context invalidated") ===
  function isExtensionContextValid() {
    try {
      return Boolean(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  async function safeStorageGet(keys) {
    if (!isExtensionContextValid()) {
      throw new Error(
        "Контекст расширения обновился (перезагрузка в chrome://extensions). Нажмите F5 на странице."
      );
    }
    try {
      return await chrome.storage.local.get(keys);
    } catch (err) {
      if (String(err?.message || err).includes("Extension context invalidated")) {
        throw new Error(
          "Контекст расширения обновился (перезагрузка в chrome://extensions). Нажмите F5 на странице."
        );
      }
      throw err;
    }
  }

  async function safeStorageSet(obj) {
    if (!isExtensionContextValid()) return;
    try {
      await chrome.storage.local.set(obj);
    } catch {
      // ignore if context invalidated during save
    }
  }

  async function safeRuntimeMessage(payload) {
    if (!isExtensionContextValid()) {
      throw new Error(
        "Контекст расширения обновился (перезагрузка в chrome://extensions). Нажмите F5 на странице."
      );
    }
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (err) {
      if (String(err?.message || err).includes("Extension context invalidated")) {
        throw new Error(
          "Контекст расширения обновился (перезагрузка в chrome://extensions). Нажмите F5 на странице."
        );
      }
      throw err;
    }
  }

  // === Реестр скачанных галерей по GID в chrome.storage.local ===
  async function getDownloadedGalleryRecord(gid) {
    if (!gid) return null;
    try {
      const res = await safeStorageGet(["downloadedGalleries"]);
      const map = res.downloadedGalleries || {};
      return map[String(gid)] || null;
    } catch {
      return null;
    }
  }

  async function saveDownloadedGalleryRecord(gid, info) {
    if (!gid) return;
    try {
      const res = await safeStorageGet(["downloadedGalleries"]);
      const map = res.downloadedGalleries || {};
      map[String(gid)] = {
        ...(map[String(gid)] || {}),
        ...info,
        updatedAt: Date.now()
      };
      await safeStorageSet({ downloadedGalleries: map });
    } catch {
      // ignore
    }
  }

  // === Хранение выбранной базовой папки (FileSystemDirectoryHandle) в IndexedDB ===
  const IDB_NAME = "ExMangaHarvesterFS";
  const IDB_STORE = "handles";
  const IDB_KEY = "rootBaseDir";

  function openHandleDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getSavedRootDirHandle() {
    let db = null;
    try {
      db = await openHandleDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    }
  }

  async function saveRootDirHandle(handle) {
    let db = null;
    try {
      db = await openHandleDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // ignore IDB errors
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    }
  }

  async function querySavedDirPermissionStatus() {
    const existing = await getSavedRootDirHandle();
    if (!existing) return { state: "missing", name: "", handle: null };
    try {
      const perm = await existing.queryPermission({ mode: "readwrite" });
      return { state: perm, name: existing.name || "Выбранная папка", handle: existing };
    } catch {
      return { state: "missing", name: "", handle: null };
    }
  }

  async function ensureBaseDirectoryHandle(forceNewPicker = false) {
    if (typeof window.showDirectoryPicker !== "function") {
      throw new Error("Браузер не поддерживает прямой доступ к папкам (File System Access API)");
    }

    if (!forceNewPicker) {
      const existing = await getSavedRootDirHandle();
      if (existing) {
        try {
          let perm = await existing.queryPermission({ mode: "readwrite" });
          if (perm !== "granted") {
            perm = await existing.requestPermission({ mode: "readwrite" });
          }
          if (perm === "granted") {
            return existing;
          }
        } catch (err) {
          if (err && err.name === "SecurityError") {
            throw new Error("NEED_USER_GESTURE_ON_PAGE");
          }
        }
      }
    }

    try {
      const picked = await window.showDirectoryPicker({
        id: "exmanga_root_dir",
        mode: "readwrite",
        startIn: "downloads"
      });
      await saveRootDirHandle(picked);
      return picked;
    } catch (err) {
      if (err && err.name === "SecurityError") {
        throw new Error("NEED_USER_GESTURE_ON_PAGE");
      }
      throw err;
    }
  }

  async function getOrCreateSubfolderHandle(rootHandle, relativeFolderPath) {
    const parts = String(relativeFolderPath || "Manga")
      .replace(/\\/g, "/")
      .split("/")
      .filter((s) => s && s !== "." && s !== "..")
      .map((s) => sanitizeName(s, 95))
      .filter(Boolean);

    let current = rootHandle;
    for (const part of parts) {
      current = await current.getDirectoryHandle(part, { create: true });
    }
    return current;
  }

  async function findExistingMangaSubfolderHandle(rootHandle, relativeFolderPath, gid, cleanTitle) {
    if (!rootHandle) return null;
    const parts = String(relativeFolderPath || "Manga")
      .replace(/\\/g, "/")
      .split("/")
      .filter((s) => s && s !== "." && s !== "..")
      .map((s) => sanitizeName(s, 95))
      .filter(Boolean);

    try {
      let current = rootHandle;
      for (const part of parts) {
        current = await current.getDirectoryHandle(part, { create: false });
      }
      return { handle: current, matchedPath: parts.join("/") };
    } catch {
      // проверим альтернативные шаблоны
    }

    const candidates = [
      cleanTitle,
      gid ? `[${gid}] ${cleanTitle}` : "",
      `Manga/${cleanTitle}`
    ].filter(Boolean);

    for (const cand of candidates) {
      if (cand === parts.join("/")) continue;
      try {
        const subParts = cand.split("/").map((s) => sanitizeName(s, 95)).filter(Boolean);
        let curr = rootHandle;
        for (const p of subParts) {
          curr = await curr.getDirectoryHandle(p, { create: false });
        }
        return { handle: curr, matchedPath: subParts.join("/") };
      } catch {
        // continue
      }
    }

    return null;
  }

  async function scanExistingPagePrefixes(dirHandle) {
    const existingByPage = new Map();
    if (!dirHandle || typeof dirHandle.entries !== "function") return existingByPage;
    try {
      for await (const [name, entry] of dirHandle.entries()) {
        if (entry.kind !== "file") continue;
        const m = name.match(/^0*(\d+)(?:_|\.)/i);
        if (!m) continue;
        try {
          const file = await entry.getFile();
          if (file && file.size >= 128) {
            existingByPage.set(Number(m[1]), name);
          }
        } catch {
          // ignore unreadable file
        }
      }
    } catch {
      // ignore directory enumeration issues
    }
    return existingByPage;
  }

  async function findExistingArchiveInRoot(rootHandle, cleanTitle, gid) {
    if (!rootHandle) return null;
    const namesToTry = [
      `${cleanTitle}.cbz`,
      `${cleanTitle}.zip`,
      gid ? `[${gid}] ${cleanTitle}.cbz` : "",
      gid ? `[${gid}] ${cleanTitle}.zip` : ""
    ].filter(Boolean);

    for (const archiveName of namesToTry) {
      try {
        const fh = await rootHandle.getFileHandle(archiveName, { create: false });
        const file = await fh.getFile();
        if (file && file.size > 512) {
          return { name: archiveName, size: file.size };
        }
      } catch {
        // not found
      }
    }
    return null;
  }

  async function inspectExistingMangaStatus(meta, folderTemplate) {
    const folderName = buildFolderPath(folderTemplate || "{title}", meta.gid, meta.title);
    const dirStatus = await querySavedDirPermissionStatus();
    state.folderPermission = dirStatus.state;
    if (dirStatus.handle) {
      state.rootDirHandle = dirStatus.handle;
    }

    if (dirStatus.state === "granted" && dirStatus.handle) {
      const foundSub = await findExistingMangaSubfolderHandle(
        dirStatus.handle,
        folderName,
        meta.gid,
        meta.title
      );
      if (foundSub && foundSub.handle) {
        state.lastMangaDirHandle = foundSub.handle;
        state.lastMatchedSubpath = foundSub.matchedPath;
        const pagesMap = await scanExistingPagePrefixes(foundSub.handle);
        const count = pagesMap.size;
        if (count >= meta.totalPages && meta.totalPages > 0) {
          await saveDownloadedGalleryRecord(meta.gid, {
            title: meta.title,
            folderName: foundSub.matchedPath,
            pagesCount: count,
            totalPages: meta.totalPages,
            complete: true
          });
          return {
            status: "complete_folder",
            existingCount: count,
            totalPages: meta.totalPages,
            matchedPath: `${dirStatus.name}/${foundSub.matchedPath}`,
            pagesMap
          };
        }
        if (count > 0) {
          return {
            status: "partial_folder",
            existingCount: count,
            totalPages: meta.totalPages,
            matchedPath: `${dirStatus.name}/${foundSub.matchedPath}`,
            pagesMap
          };
        }
      }

      const foundArch = await findExistingArchiveInRoot(dirStatus.handle, meta.title, meta.gid);
      if (foundArch) {
        await saveDownloadedGalleryRecord(meta.gid, {
          title: meta.title,
          archiveName: foundArch.name,
          pagesCount: meta.totalPages,
          totalPages: meta.totalPages,
          complete: true
        });
        return {
          status: "complete_archive",
          existingCount: meta.totalPages,
          totalPages: meta.totalPages,
          matchedPath: `${dirStatus.name}/${foundArch.name}`,
          pagesMap: new Map()
        };
      }
    }

    const cachedRecord = await getDownloadedGalleryRecord(meta.gid);
    if (cachedRecord && cachedRecord.complete) {
      return {
        status: "complete_cached",
        existingCount: cachedRecord.pagesCount || meta.totalPages,
        totalPages: meta.totalPages,
        matchedPath: cachedRecord.folderName || cachedRecord.archiveName || folderName,
        pagesMap: new Map()
      };
    }

    return {
      status: "none",
      existingCount: 0,
      totalPages: meta.totalPages,
      matchedPath: folderName,
      pagesMap: new Map()
    };
  }

  async function writeComicInfoDirectly(targetMangaDirHandle, meta, includeComicInfo = true) {
    if (!targetMangaDirHandle || !meta || includeComicInfo === false) return false;
    try {
      const ciHandle = await targetMangaDirHandle.getFileHandle("ComicInfo.xml", {
        create: true
      });
      const ciWritable = await ciHandle.createWritable();
      await ciWritable.write(buildComicInfoXml(meta));
      await ciWritable.close();
      return true;
    } catch {
      return false;
    }
  }

  const path = window.location.pathname;
  const isGalleryPage = path.startsWith("/g/");
  const isReaderPage = path.startsWith("/s/");

  if (!isGalleryPage && !isReaderPage) return;

  function detectPageMetadata() {
    return detectMetaWithMode(isGalleryPage);
  }

  const state = {
    running: false,
    paused: false,
    cancelled: false,
    current: 0,
    total: 0,
    statusText: "Готов к работе",
    meta: null,
    rootDirHandle: null,
    lastMangaDirHandle: null,
    lastMatchedSubpath: "",
    lastSaveMode: "folder",
    folderPermission: "missing",
    existingStatus: "none",
    existingCount: 0
  };

  async function resolveReaderUrlForPage(targetPage, meta) {
    if (isReaderPage) {
      const m = window.location.pathname.match(/\/s\/([a-f0-9]+)\/(\d+)-(\d+)/i);
      if (m && Number(m[3]) === targetPage) {
        return window.location.href.split("?")[0];
      }
    }

    if (isGalleryPage) {
      const direct = findReaderLinkInGalleryDoc(document, meta.gid, targetPage);
      if (direct) return direct;
    }

    let baseGalleryPath = "";
    if (isGalleryPage) {
      baseGalleryPath = window.location.pathname;
    } else {
      const backLink = document.querySelector("#i5 a")?.getAttribute("href");
      if (backLink) {
        baseGalleryPath = new URL(backLink, window.location.origin).pathname;
      } else if (meta.gid && meta.token) {
        baseGalleryPath = `/g/${meta.gid}/${meta.token}/`;
      } else {
        throw new Error("Не найдена ссылка на галерею (#i5 a) для поиска страницы");
      }
    }

    let perPage = meta.perPage || 0;
    if (!perPage) {
      const p0Url = `${window.location.origin}${baseGalleryPath}?p=0`;
      const p0Res = await fetchWithTimeout(p0Url, { credentials: "include" });
      if (!p0Res.ok) throw new Error(`Не удалось загрузить галерею ?p=0 (HTTP ${p0Res.status})`);
      const p0Html = await p0Res.text();
      const p0Doc = new DOMParser().parseFromString(p0Html, "text/html");

      if (!meta.jpTitle) {
        meta.jpTitle = p0Doc.querySelector("#gj")?.textContent?.trim() || "";
      }
      if (!meta.tags || Object.keys(meta.tags).length === 0) {
        meta.tags = parseGalleryTags(p0Doc);
      }

      const foundOnP0 = findReaderLinkInGalleryDoc(p0Doc, meta.gid, targetPage);
      if (foundOnP0) return foundOnP0;

      const pagination = computeGalleryPagination(p0Doc, p0Url);
      perPage = pagination.perPage || 20;
      meta.perPage = perPage;
    }

    const pageIndex = Math.floor((targetPage - 1) / perPage);
    const galleryUrl = `${window.location.origin}${baseGalleryPath}?p=${pageIndex}`;
    const res = await fetchWithTimeout(galleryUrl, { credentials: "include" });
    if (!res.ok) throw new Error(`Не удалось загрузить лист галереи ?p=${pageIndex}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const found = findReaderLinkInGalleryDoc(doc, meta.gid, targetPage);
    if (found) return found;

    throw new Error(`Не найдена ссылка на страницу #${targetPage} на листе галереи ?p=${pageIndex}`);
  }

  async function fetchShowPageWithRetry(apiUrl, payload, updateStatus) {
    let lastErr = null;
    for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
      if (state.cancelled || instanceAborted) {
        throw new Error("Загрузка отменена пользователем");
      }
      try {
        const apiRes = await fetchWithTimeout(
          apiUrl,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          },
          NETWORK_TIMEOUT_MS
        );

        if (!apiRes.ok) {
          const retryable = apiRes.status === 429 || apiRes.status >= 500;
          if (retryable && attempt < API_MAX_RETRIES) {
            updateStatus(
              `API ответил HTTP ${apiRes.status} на стр. ${payload.page}. Повтор (${attempt + 1}/${API_MAX_RETRIES})...`
            );
            await sleep(1600 + attempt * 900);
            continue;
          }
          throw new Error(`Ошибка ответа API на странице ${payload.page}: HTTP ${apiRes.status}`);
        }

        const data = await apiRes.json();
        if (data.error) {
          throw new Error(`API вернул ошибку: ${data.error}`);
        }
        return data;
      } catch (err) {
        lastErr = err;
        if (state.cancelled || instanceAborted) {
          throw new Error("Загрузка отменена пользователем");
        }
        if (attempt < API_MAX_RETRIES) {
          updateStatus(
            `Сбой сети API на стр. ${payload.page} (${err?.message || "ошибка"}). Повтор (${attempt + 1}/${API_MAX_RETRIES})...`
          );
          await sleep(1600 + attempt * 900);
          continue;
        }
      }
    }
    throw lastErr || new Error(`Не удалось получить страницу ${payload.page} от API`);
  }

  async function fetchPageWithRetry({
    pageNumber,
    gid,
    imgKey,
    currentInfo,
    settings,
    updateStatus
  }) {
    let info = { ...currentInfo };
    const maxRetries = Math.max(0, Number(settings.maxRetries ?? 3));
    let forceCompressedFallback = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (state.cancelled || instanceAborted) {
        throw new Error("Загрузка отменена пользователем");
      }

      const useOriginal = Boolean(
        !forceCompressedFallback && settings.quality === "original" && info.fullImgUrl
      );
      const targetUrl = useOriginal ? info.fullImgUrl : info.imgUrl;

      if (!targetUrl) {
        throw new Error(`Не найден URL изображения на странице ${pageNumber}`);
      }

      const resp = await safeRuntimeMessage({
        action: "fetchImageBytes",
        url: targetUrl,
        includeCredentials: useOriginal
      });

      if (resp && resp.ok && resp.base64) {
        return {
          resp,
          usedUrl: resp.finalUrl || targetUrl,
          info,
          usedFallback: forceCompressedFallback
        };
      }

      if (useOriginal && info.imgUrl && settings.fallbackOriginal !== false) {
        updateStatus(
          `Оригинал стр. ${pageNumber} недоступен (${resp?.error || "лимит"}). Авто-переход на сжатую копию...`
        );
        forceCompressedFallback = true;
        attempt--;
        continue;
      }

      if (attempt < maxRetries && info.nlToken && imgKey) {
        updateStatus(
          `Сбой узла на стр. ${pageNumber} (${resp?.error || "ошибка"}). Смена зеркала nl (${attempt + 1}/${maxRetries})...`
        );
        await sleep(900 + Math.floor(Math.random() * 300));
        try {
          const fallbackReaderUrl = `${window.location.origin}/s/${imgKey}/${gid}-${pageNumber}?nl=${encodeURIComponent(info.nlToken)}`;
          const nlRes = await fetchWithTimeout(fallbackReaderUrl, { credentials: "include" });
          if (nlRes.ok) {
            const nlHtml = await nlRes.text();
            const refreshed = parseFullReaderDocument(nlHtml);
            if (refreshed.imgUrl) {
              info = {
                ...info,
                imgUrl: refreshed.imgUrl,
                fullImgUrl: refreshed.fullImgUrl || info.fullImgUrl,
                nlToken: refreshed.nlToken || info.nlToken,
                nextPage: refreshed.nextPage || info.nextPage,
                nextImgKey: refreshed.nextImgKey || info.nextImgKey
              };
              continue;
            }
          }
        } catch {
          // Сбой при запросе nl — попробуем следующую попытку
        }
      } else if (attempt < maxRetries) {
        updateStatus(`Повтор скачивания стр. ${pageNumber} (${attempt + 1}/${maxRetries})...`);
        await sleep(900 + Math.floor(Math.random() * 300));
      } else {
        throw new Error(`Сбой скачивания страницы ${pageNumber}: ${resp?.error || "нет ответа"}`);
      }
    }
  }

  async function waitWhilePaused() {
    while (state.paused && !state.cancelled && !instanceAborted) {
      await sleep(250);
    }
  }

  async function saveArchiveToDisk(collectedFiles, meta, settings, archiveFileName, rootHandle = null) {
    const isCbz = settings.saveMode === "cbz";
    const filesToPack = [...collectedFiles];
    if (settings.includeComicInfo !== false) {
      filesToPack.push({
        name: "ComicInfo.xml",
        data: buildComicInfoXml(meta)
      });
    }

    const zipBlob = buildZipBlob(
      filesToPack,
      isCbz ? "application/vnd.comicbook+zip" : "application/zip"
    );

    const activeRoot = rootHandle || state.rootDirHandle;
    const rootName = activeRoot?.name ? sanitizeName(activeRoot.name, 95) : "";
    const isRootDownloadsItself = !rootName || /^(downloads|загрузки)$/i.test(rootName);

    if (activeRoot) {
      try {
        const perm = await activeRoot.queryPermission({ mode: "readwrite" });
        if (perm === "granted") {
          const fileHandle = await activeRoot.getFileHandle(archiveFileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(zipBlob);
          await writable.close();
          return { savedInRootDir: true, dirName: activeRoot.name };
        }
      } catch {
        // ignore and fallback
      }
    }

    const blobUrl = URL.createObjectURL(zipBlob);
    const dlRelPath = isRootDownloadsItself ? archiveFileName : `${rootName}/${archiveFileName}`;
    try {
      const dlResp = await safeRuntimeMessage({
        action: "downloadArchiveBlobUrl",
        blobUrl,
        filename: dlRelPath
      });
      if (dlResp && dlResp.ok) {
        if (typeof dlResp.downloadId === "number") {
          await saveDownloadedGalleryRecord(meta.gid, {
            explorerDownloadId: dlResp.downloadId,
            archiveName: archiveFileName
          });
        }
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        return { savedInRootDir: !isRootDownloadsItself, dirName: rootName || "Загрузки" };
      }
    } catch {
      // Fallback
    }

    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = archiveFileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    return { savedInRootDir: false, dirName: "Загрузки" };
  }

  async function handleOpenDownloadedFolder() {
    try {
      const meta = state.meta || detectPageMetadata();
      const cachedRecord = await getDownloadedGalleryRecord(meta.gid);

      if (cachedRecord && typeof cachedRecord.explorerDownloadId === "number") {
        const showRes = await safeRuntimeMessage({
          action: "showDownloadIdInExplorer",
          downloadId: cachedRecord.explorerDownloadId
        });
        if (showRes && showRes.ok) {
          return;
        }
      }

      await safeRuntimeMessage({
        action: "openDownloadsFolder",
        preferShowLastFile: true
      });
    } catch (err) {
      syncUI(err.message || String(err));
    }
  }

  function highlightButton(btnEl, message) {
    if (message) syncUI(message);
    const target = btnEl || uiEls?.pickDirBtn;
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("mhs-btn-pulse");
    setTimeout(() => {
      target.classList.remove("mhs-btn-pulse");
    }, 4500);
  }

  async function startHarvest(customOptions = {}, preAcquiredRootDirHandle = null, forceRedownload = false) {
    if (state.running) return;
    const meta = detectPageMetadata();
    state.meta = meta;

    let stored = {};
    try {
      stored = await safeStorageGet(["harvesterSettings"]);
    } catch (err) {
      syncUI(`Остановлено: ${err.message || String(err)}`);
      return;
    }

    const settings = {
      saveMode: "folder",
      quality: "webp",
      delayMs: 1200,
      maxRetries: 3,
      folderTemplate: "{title}",
      fileTemplate: "{page_pad}_{orig_name}",
      smartResume: true,
      includeComicInfo: true,
      fallbackOriginal: true,
      ...(stored.harvesterSettings || {}),
      ...customOptions
    };

    if (settings.saveMode === "picker") {
      settings.saveMode = "folder";
    }
    state.lastSaveMode = settings.saveMode;

    await safeStorageSet({
      harvesterSettings: {
        saveMode: settings.saveMode,
        quality: settings.quality,
        delayMs: settings.delayMs,
        maxRetries: settings.maxRetries,
        folderTemplate: settings.folderTemplate,
        fileTemplate: settings.fileTemplate,
        smartResume: settings.smartResume,
        includeComicInfo: settings.includeComicInfo,
        fallbackOriginal: settings.fallbackOriginal
      }
    });

    const startPage = Math.max(1, Math.min(meta.totalPages, Number(settings.startPage || 1)));
    const endPage = Math.max(
      startPage,
      Math.min(meta.totalPages, Number(settings.endPage || meta.totalPages))
    );
    const totalToDownload = endPage - startPage + 1;
    const folderName = buildFolderPath(settings.folderTemplate || "{title}", meta.gid, meta.title);

    let targetMangaDirHandle = null;
    let rootHandle = preAcquiredRootDirHandle || state.rootDirHandle;
    let rootDirName = "";
    let existingPagesMap = new Map();

    if (settings.saveMode === "folder") {
      try {
        rootHandle = rootHandle || (await ensureBaseDirectoryHandle(false));
        state.rootDirHandle = rootHandle;
        state.folderPermission = "granted";
        rootDirName = rootHandle.name || "Выбранная папка";
        updateFolderBtnLabel(rootDirName, "granted");
      } catch (err) {
        if (err && err.message === "NEED_USER_GESTURE_ON_PAGE") {
          highlightButton(
            uiEls?.pickDirBtn,
            "Браузер требует 1 клик на самой странице для доступа к папке — нажмите подсвеченную кнопку «📁 Куда» или «Скачать» на панели страницы."
          );
        } else {
          syncUI("Выбор папки отменён пользователем.");
        }
        return;
      }
    } else if (!rootHandle) {
      const saved = await getSavedRootDirHandle();
      if (saved) {
        try {
          let perm = await saved.queryPermission({ mode: "readwrite" });
          if (perm !== "granted") {
            perm = await saved.requestPermission({ mode: "readwrite" });
          }
          if (perm === "granted") {
            rootHandle = saved;
            state.rootDirHandle = saved;
            state.folderPermission = "granted";
            rootDirName = saved.name || "Выбранная папка";
            updateFolderBtnLabel(rootDirName, "granted");
          }
        } catch {
          // ignore
        }
      }
    }

    // === ПРОВЕРКА НА ДУБЛИКАТ ПЕРЕД СКАЧИВАНИЕМ ===
    if (!forceRedownload && settings.smartResume !== false && rootHandle) {
      if (settings.saveMode === "folder") {
        const existingSub = await findExistingMangaSubfolderHandle(
          rootHandle,
          folderName,
          meta.gid,
          meta.title
        );
        if (existingSub && existingSub.handle) {
          targetMangaDirHandle = existingSub.handle;
          state.lastMangaDirHandle = existingSub.handle;
          state.lastMatchedSubpath = existingSub.matchedPath;
          existingPagesMap = await scanExistingPagePrefixes(existingSub.handle);

          let alreadyHaveInRange = 0;
          for (let p = startPage; p <= endPage; p++) {
            if (existingPagesMap.has(p)) alreadyHaveInRange++;
          }

          if (alreadyHaveInRange >= totalToDownload) {
            state.existingStatus = "complete_folder";
            state.existingCount = existingPagesMap.size;
            state.current = totalToDownload;
            state.total = totalToDownload;
            await writeComicInfoDirectly(
              existingSub.handle,
              meta,
              settings.includeComicInfo !== false
            );
            await saveDownloadedGalleryRecord(meta.gid, {
              title: meta.title,
              folderName: existingSub.matchedPath,
              pagesCount: existingPagesMap.size,
              totalPages: meta.totalPages,
              complete: true
            });
            applyExistingBadgeUI();
            syncUI(
              `✅ Эта манга уже полностью лежит в папке "${rootDirName}/${existingSub.matchedPath}" (${alreadyHaveInRange}/${totalToDownload} стр.)! Повторное скачивание не требуется (Shift + клик по «Скачать» — перекачать заново).`
            );
            return;
          }
        }
      } else {
        const existingArch = await findExistingArchiveInRoot(rootHandle, meta.title, meta.gid);
        if (existingArch && startPage === 1 && endPage === meta.totalPages) {
          state.existingStatus = "complete_archive";
          state.existingCount = meta.totalPages;
          state.current = totalToDownload;
          state.total = totalToDownload;
          applyExistingBadgeUI();
          syncUI(
            `✅ Архив этой манги "${existingArch.name}" уже лежит в папке "${rootHandle.name}"! Повторное скачивание не требуется (Shift + клик по «Скачать» — перекачать заново).`
          );
          return;
        }
      }
    }

    if (settings.saveMode === "folder" && !targetMangaDirHandle) {
      targetMangaDirHandle = await getOrCreateSubfolderHandle(rootHandle, folderName);
      state.lastMangaDirHandle = targetMangaDirHandle;
      state.lastMatchedSubpath = folderName;
      if (!forceRedownload && settings.smartResume !== false) {
        existingPagesMap = await scanExistingPagePrefixes(targetMangaDirHandle);
      }
    }

    if (settings.saveMode === "folder" && targetMangaDirHandle && settings.includeComicInfo !== false) {
      await writeComicInfoDirectly(targetMangaDirHandle, meta, true);
    }

    state.running = true;
    state.paused = false;
    state.cancelled = false;
    state.current = 0;
    state.total = totalToDownload;
    syncUI("Инициализация стартовой страницы...");

    const collectedFiles = [];
    let collectedBytes = 0;
    let savedPartCount = 0;
    let totalPackedPages = 0;
    let lastCompletedPage = startPage - 1;
    let skippedCount = 0;

    async function flushArchiveVolume(isFinalPart) {
      if (collectedFiles.length === 0) return null;
      const ext = settings.saveMode === "cbz" ? "cbz" : "zip";
      const rangeSuffix =
        startPage === 1 && endPage === meta.totalPages ? "" : `_p${startPage}-${endPage}`;
      const partSuffix =
        !isFinalPart || savedPartCount > 0 ? `_part${savedPartCount + 1}` : "";
      const archiveName = `${meta.title}${rangeSuffix}${partSuffix}.${ext}`;

      syncUI(
        `Упаковка тома ${savedPartCount + 1} (${collectedFiles.length} стр.) в ${ext.toUpperCase()}...`
      );
      const saveRes = await saveArchiveToDisk(
        collectedFiles,
        meta,
        settings,
        archiveName,
        rootHandle
      );
      totalPackedPages += collectedFiles.length;
      savedPartCount += 1;
      collectedFiles.length = 0;
      collectedBytes = 0;
      return { archiveName, saveRes };
    }

    try {
      let gid = meta.gid;
      let apiUrl = meta.apiUrl;
      let showkey = meta.showkey;
      let currentImgKey = meta.startkey;
      let currentInfo = null;
      let lastApiCallTs = 0;

      for (let page = startPage; page <= endPage; page++) {
        await waitWhilePaused();
        if (state.cancelled || instanceAborted) {
          throw new Error("Загрузка отменена пользователем");
        }

        const stepIndex = page - startPage + 1;

        if (!forceRedownload && settings.saveMode === "folder" && existingPagesMap.has(page)) {
          skippedCount++;
          state.current = stepIndex;
          lastCompletedPage = page;
          syncUI(
            `Пропуск стр. ${page} (уже есть в папке: ${existingPagesMap.get(page)}) [${stepIndex}/${totalToDownload}]`
          );
          currentInfo = null;
          currentImgKey = "";
          continue;
        }

        if (!currentInfo) {
          if (!isGalleryPage && page === meta.startPage && showkey) {
            const i3Html = document.querySelector("#i3")?.innerHTML || "";
            const i6Html = document.querySelector("#i6")?.innerHTML || "";
            const i7Html = document.querySelector("#i7")?.innerHTML || "";
            const i2Html = document.querySelector("#i2")?.innerHTML || "";
            currentInfo = parseReaderFragments(i3Html, i6Html, i7Html, i2Html);
          } else {
            syncUI(`Получение ключей страницы #${page}...`);
            const readerUrl = await resolveReaderUrlForPage(page, meta);
            const keyMatch = readerUrl.match(/\/s\/([a-f0-9]+)\/(\d+)-(\d+)/i);
            if (keyMatch) currentImgKey = keyMatch[1];

            const firstRes = await fetchWithTimeout(readerUrl, { credentials: "include" });
            if (!firstRes.ok) throw new Error(`Ошибка загрузки страницы ридера #${page}`);
            const firstHtml = await firstRes.text();
            const parsedFirst = parseFullReaderDocument(firstHtml);
            gid = parsedFirst.gid || gid;
            showkey = parsedFirst.showkey || showkey;
            apiUrl = parsedFirst.apiUrl || apiUrl;
            currentInfo = parsedFirst;
            lastApiCallTs = performance.now();
          }
        }

        syncUI(`Скачивание страницы ${page} из ${endPage} (${stepIndex}/${totalToDownload})...`);

        const { resp, usedUrl, info } = await fetchPageWithRetry({
          pageNumber: page,
          gid,
          imgKey: currentImgKey,
          currentInfo,
          settings,
          updateStatus: (txt) => syncUI(txt)
        });
        currentInfo = info;

        const { stem, ext } = extractOriginalBaseName(usedUrl, resp.contentType, page);
        const entryFileName = formatEntryName(
          page,
          meta.totalPages,
          stem,
          ext,
          settings.fileTemplate
        );

        const bytes = base64ToUint8Array(resp.base64);

        if (settings.saveMode === "folder" && targetMangaDirHandle) {
          const fileHandle = await targetMangaDirHandle.getFileHandle(entryFileName, {
            create: true
          });
          const writable = await fileHandle.createWritable();
          await writable.write(bytes);
          await writable.close();
        } else {
          // Если добавление файла превысит лимит тома (450 МБ) — сбрасываем текущий том на диск, чтобы избежать OOM
          if (collectedFiles.length > 0 && collectedBytes + bytes.length > MAX_ARCHIVE_PART_BYTES) {
            await flushArchiveVolume(false);
          }
          collectedFiles.push({ name: entryFileName, data: bytes });
          collectedBytes += bytes.length;
        }

        state.current = stepIndex;
        lastCompletedPage = page;
        syncUI(`Готово ${stepIndex} из ${totalToDownload} (${folderName}/${entryFileName})`);

        if (page >= endPage) break;

        const nextPage = page + 1;
        if (!forceRedownload && settings.saveMode === "folder" && existingPagesMap.has(nextPage)) {
          currentInfo = null;
          continue;
        }

        let nextImgKey = currentInfo.nextImgKey;
        if (!nextImgKey) {
          const nextReaderUrl = await resolveReaderUrlForPage(nextPage, meta);
          const m = nextReaderUrl.match(/\/s\/([a-f0-9]+)\/(\d+)-(\d+)/i);
          if (m) nextImgKey = m[1];
        }
        if (!nextImgKey) {
          throw new Error(`Не найден ключ следующей страницы после стр. ${page}`);
        }

        if (!showkey) {
          throw new Error("Не удалось извлечь showkey со страницы ридера");
        }

        await waitWhilePaused();
        if (state.cancelled || instanceAborted) {
          throw new Error("Загрузка отменена пользователем");
        }

        const baseDelay = Math.max(1050, Number(settings.delayMs || 1200));
        const jitter = 80 + Math.floor(Math.random() * 180);
        const targetInterval = baseDelay + jitter;
        const elapsedSinceLastApi =
          lastApiCallTs > 0 ? performance.now() - lastApiCallTs : targetInterval;
        const remainingWait = Math.max(250, targetInterval - elapsedSinceLastApi);
        await sleep(remainingWait);

        lastApiCallTs = performance.now();
        const data = await fetchShowPageWithRetry(
          apiUrl,
          {
            method: "showpage",
            gid: Number(gid),
            page: Number(nextPage),
            imgkey: nextImgKey,
            showkey
          },
          (txt) => syncUI(txt)
        );

        currentImgKey = nextImgKey;
        currentInfo = parseReaderFragments(
          data.i3 || "",
          data.i6 || "",
          data.i7 || "",
          data.n || ""
        );
      }

      if (settings.saveMode === "cbz" || settings.saveMode === "zip") {
        const finalFlush = await flushArchiveVolume(true);
        if (finalFlush || savedPartCount > 0) {
          const lastArchiveName = finalFlush ? finalFlush.archiveName : `${meta.title}.${settings.saveMode}`;
          const lastSaveRes = finalFlush ? finalFlush.saveRes : { savedInRootDir: false, dirName: "Загрузки" };
          state.existingStatus = "complete_archive";
          state.existingCount = totalPackedPages;
          await saveDownloadedGalleryRecord(meta.gid, {
            title: meta.title,
            archiveName: lastArchiveName,
            pagesCount: totalPackedPages,
            totalPages: meta.totalPages,
            complete: startPage === 1 && endPage === meta.totalPages
          });
          applyExistingBadgeUI();

          const whereText = lastSaveRes.savedInRootDir
            ? `в папку "${lastSaveRes.dirName}/${lastArchiveName}"`
            : `как "${lastArchiveName}"`;
          const partsNote = savedPartCount > 1 ? ` (разбито на ${savedPartCount} тома)` : "";
          syncUI(
            `✅ Архив сохранён ${whereText}${partsNote} (${totalPackedPages} стр.)! Нажмите «📂 Открыть папку».`
          );
        }
      } else {
        if (targetMangaDirHandle && settings.includeComicInfo !== false) {
          await writeComicInfoDirectly(targetMangaDirHandle, meta, true);
        }
        state.existingStatus = "complete_folder";
        state.existingCount = meta.totalPages;
        await saveDownloadedGalleryRecord(meta.gid, {
          title: meta.title,
          folderName,
          pagesCount: totalToDownload,
          totalPages: meta.totalPages,
          complete: startPage === 1 && endPage === meta.totalPages
        });
        applyExistingBadgeUI();

        const skippedNote = skippedCount > 0 ? ` (пропущено уже бывших: ${skippedCount})` : "";
        syncUI(
          `✅ Готово! Все ${totalToDownload} стр.${skippedNote} сохранены в "${rootDirName}/${folderName}". Нажмите «📂 Открыть папку».`
        );
      }
    } catch (err) {
      if (
        (settings.saveMode === "cbz" || settings.saveMode === "zip") &&
        collectedFiles.length > 0
      ) {
        try {
          const ext = settings.saveMode === "cbz" ? "cbz" : "zip";
          const partialName = `${meta.title}_partial_p${startPage}-${lastCompletedPage}.${ext}`;
          await saveArchiveToDisk(collectedFiles, meta, settings, partialName, rootHandle);
          syncUI(
            `Остановлено (${err.message || String(err)}). Спасён частичный архив "${partialName}" (${collectedFiles.length} стр.)!`
          );
        } catch {
          syncUI(`Остановлено: ${err.message || String(err)}`);
        }
      } else {
        syncUI(`Остановлено: ${err.message || String(err)}`);
      }
    } finally {
      state.running = false;
      state.paused = false;
      syncUI(state.statusText);
    }
  }

  let uiEls = null;
  let readerObserver = null;

  function updateFolderBtnLabel(dirName, permState = "granted") {
    if (!uiEls || !uiEls.pickDirBtn) return;
    if (dirName && permState === "granted") {
      uiEls.pickDirBtn.textContent = `📁 Куда: ${dirName}`;
      uiEls.pickDirBtn.title = `Текущая базовая папка: ${dirName} (доступ активен). Нажмите, чтобы сменить.`;
    } else if (dirName) {
      uiEls.pickDirBtn.textContent = `🔓 Подтвердить папку: ${dirName}`;
      uiEls.pickDirBtn.title = `Нажмите 1 раз, чтобы подтвердить доступ к папке "${dirName}" и проверить наличие этой манги на диске.`;
    } else {
      uiEls.pickDirBtn.textContent = "📁 Выбрать базовую папку";
      uiEls.pickDirBtn.title =
        "Выберите общую папку 1 раз — внутри неё будет автоматически создаваться папка для каждой манги без окон Проводника";
    }
  }

  function applyExistingBadgeUI() {
    if (!uiEls || !uiEls.existingBadge || !state.meta) return;
    const st = state.existingStatus;
    if (st === "complete_folder" || st === "complete_archive" || st === "complete_cached") {
      uiEls.existingBadge.style.display = "inline-flex";
      uiEls.existingBadge.className = "mhs-badge mhs-badge-ok";
      uiEls.existingBadge.textContent =
        st === "complete_archive"
          ? "✅ Архив уже в папке"
          : `✅ Уже в папке (${state.existingCount}/${state.meta.totalPages} стр.)`;
      uiEls.startBtn.textContent = "✅ Уже скачано";
      uiEls.startBtn.classList.add("mhs-btn-done");
      uiEls.startBtn.title =
        "Эта манга уже есть в папке (повторно качать не нужно). Shift + клик — принудительно перекачать заново.";
    } else if (st === "partial_folder") {
      const rem = Math.max(0, state.meta.totalPages - state.existingCount);
      uiEls.existingBadge.style.display = "inline-flex";
      uiEls.existingBadge.className = "mhs-badge mhs-badge-warn";
      uiEls.existingBadge.textContent = `⚠️ В папке: ${state.existingCount}/${state.meta.totalPages} стр.`;
      uiEls.startBtn.textContent = `▶ Докачать (${rem} стр.)`;
      uiEls.startBtn.classList.remove("mhs-btn-done");
      uiEls.startBtn.title = `В папке уже есть ${state.existingCount} стр. Нажмите, чтобы докачать оставшиеся ${rem} стр.`;
    } else {
      uiEls.existingBadge.style.display = "none";
      uiEls.startBtn.textContent = "Скачать";
      uiEls.startBtn.classList.remove("mhs-btn-done");
      uiEls.startBtn.title = "Скачать выбранные страницы манги";
    }
  }

  function syncUI(statusText) {
    if (statusText) state.statusText = statusText;
    if (!uiEls) return;
    const pct = state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;
    uiEls.progressWrap.classList.toggle("active", state.running || state.current > 0);
    uiEls.progressFill.style.width = `${pct}%`;
    uiEls.statusLabel.textContent = state.statusText;
    uiEls.counterLabel.textContent =
      state.total > 0 ? `${state.current} / ${state.total} (${pct}%)` : "";
    uiEls.startBtn.disabled = state.running;
    uiEls.pauseBtn.disabled = !state.running;
    uiEls.pauseBtn.textContent = state.paused ? "Продолжить" : "Пауза";
    uiEls.cancelBtn.disabled = !state.running;
    if (!state.running) {
      applyExistingBadgeUI();
    }
  }

  async function refreshExistingStatusOnPanel(folderTemplate) {
    if (!state.meta) return;
    const check = await inspectExistingMangaStatus(state.meta, folderTemplate);
    state.existingStatus = check.status;
    state.existingCount = check.existingCount;
    if (
      check.status === "complete_folder" ||
      check.status === "complete_archive" ||
      check.status === "complete_cached"
    ) {
      state.current = state.meta.totalPages;
      state.total = state.meta.totalPages;
      syncUI(`✅ Манга уже сохранена (${check.matchedPath}). Второй раз скачивать не нужно.`);
    } else if (check.status === "partial_folder") {
      state.current = check.existingCount;
      state.total = state.meta.totalPages;
      syncUI(
        `⚠️ В папке уже есть ${check.existingCount} из ${state.meta.totalPages} стр. Нажмите «▶ Докачать», чтобы продолжить.`
      );
    } else {
      applyExistingBadgeUI();
    }
  }

  async function mountPanel() {
    const oldPanel = document.getElementById("mhs-root-panel");
    if (oldPanel) {
      oldPanel.remove();
    }

    const meta = detectPageMetadata();
    if (!meta.gid || (!document.querySelector("#gdt") && !document.querySelector("#i3"))) {
      return;
    }
    state.meta = meta;

    let s = {};
    try {
      const stored = await safeStorageGet(["harvesterSettings"]);
      s = stored.harvesterSettings || {};
    } catch {
      s = {};
    }

    const curMode = s.saveMode === "picker" ? "folder" : (s.saveMode || "folder");
    state.lastSaveMode = curMode;

    const dirStatus = await querySavedDirPermissionStatus();
    state.folderPermission = dirStatus.state;
    if (dirStatus.handle) {
      state.rootDirHandle = dirStatus.handle;
    }

    const panel = document.createElement("div");
    panel.id = "mhs-root-panel";
    panel.className = `mhs-panel ${isReaderPage ? "mhs-reader-floating" : ""}`;
    panel.innerHTML = `
      <div class="mhs-header">
        <div class="mhs-title">
          <span>ExManga Harvester v2.0</span>
          <span class="mhs-badge" id="mhs-badge-meta"></span>
          <span class="mhs-badge" id="mhs-badge-existing" style="display:none;"></span>
        </div>
        <div class="mhs-folder-preview" id="mhs-folder-preview"></div>
      </div>
      <div class="mhs-controls">
        <div class="mhs-field">
          <label>Страницы:</label>
          <input type="number" class="mhs-input" id="mhs-start" min="1" />
          <span>—</span>
          <input type="number" class="mhs-input" id="mhs-end" min="1" />
        </div>
        <div class="mhs-field">
          <label>Формат:</label>
          <select class="mhs-select" id="mhs-mode">
            <option value="folder">В папку &lt;Название манги&gt; (без окон)</option>
            <option value="cbz">Единый .CBZ архив</option>
            <option value="zip">Единый .ZIP архив</option>
          </select>
        </div>
        <div class="mhs-field">
          <button type="button" class="mhs-btn mhs-btn-secondary" id="mhs-btn-pickdir"></button>
        </div>
        <div class="mhs-field">
          <label>Качество:</label>
          <select class="mhs-select" id="mhs-quality">
            <option value="webp">Сжатый (ридер)</option>
            <option value="original">Оригинал (fullimg)</option>
          </select>
        </div>
        <div class="mhs-actions">
          <button class="mhs-btn mhs-btn-primary" id="mhs-btn-start">Скачать</button>
          <button class="mhs-btn mhs-btn-secondary" id="mhs-btn-pause" disabled>Пауза</button>
          <button class="mhs-btn mhs-btn-danger" id="mhs-btn-cancel" disabled>Отмена</button>
          <button class="mhs-btn mhs-btn-secondary" id="mhs-btn-openfolder" title="Открыть папку с этой мангой в обычном Проводнике Windows">📂 Открыть папку</button>
        </div>
      </div>
      <div class="mhs-progress-wrap" id="mhs-progress-wrap">
        <div class="mhs-progress-bar-bg">
          <div class="mhs-progress-bar-fill" id="mhs-progress-fill"></div>
        </div>
        <div class="mhs-status-line">
          <span id="mhs-status-text">Готов к работе</span>
          <span id="mhs-counter-text"></span>
        </div>
      </div>
    `;

    if (isGalleryPage) {
      const gdt = document.querySelector("#gdt");
      if (gdt && gdt.parentNode) {
        gdt.parentNode.insertBefore(panel, gdt);
      } else {
        document.body.prepend(panel);
      }
    } else {
      const i1 = document.querySelector("#i1");
      const i2 = document.querySelector("#i2");
      if (i1 && i2) {
        i1.insertBefore(panel, i2);
      } else {
        document.body.prepend(panel);
      }
    }

    uiEls = {
      badgeMeta: panel.querySelector("#mhs-badge-meta"),
      existingBadge: panel.querySelector("#mhs-badge-existing"),
      folderPreview: panel.querySelector("#mhs-folder-preview"),
      startInput: panel.querySelector("#mhs-start"),
      endInput: panel.querySelector("#mhs-end"),
      modeSelect: panel.querySelector("#mhs-mode"),
      pickDirBtn: panel.querySelector("#mhs-btn-pickdir"),
      qualitySelect: panel.querySelector("#mhs-quality"),
      startBtn: panel.querySelector("#mhs-btn-start"),
      pauseBtn: panel.querySelector("#mhs-btn-pause"),
      cancelBtn: panel.querySelector("#mhs-btn-cancel"),
      openFolderBtn: panel.querySelector("#mhs-btn-openfolder"),
      progressWrap: panel.querySelector("#mhs-progress-wrap"),
      progressFill: panel.querySelector("#mhs-progress-fill"),
      statusLabel: panel.querySelector("#mhs-status-text"),
      counterLabel: panel.querySelector("#mhs-counter-text")
    };

    uiEls.badgeMeta.textContent = `GID: ${meta.gid} • ${meta.totalPages} стр.`;
    const previewSubfolder = buildFolderPath(s.folderTemplate || "{title}", meta.gid, meta.title);
    uiEls.folderPreview.textContent = `Папка манги: ${previewSubfolder}`;
    uiEls.folderPreview.title = previewSubfolder;

    uiEls.startInput.max = String(meta.totalPages);
    uiEls.startInput.value = String(meta.startPage);
    uiEls.endInput.max = String(meta.totalPages);
    uiEls.endInput.value = String(meta.totalPages);
    uiEls.modeSelect.value = curMode;
    uiEls.qualitySelect.value = s.quality === "original" ? "original" : "webp";

    updateFolderBtnLabel(dirStatus.name, dirStatus.state);

    await refreshExistingStatusOnPanel(s.folderTemplate || "{title}");

    const saveInlineSelects = async () => {
      try {
        const currentStored = await safeStorageGet(["harvesterSettings"]);
        await safeStorageSet({
          harvesterSettings: {
            ...(currentStored.harvesterSettings || {}),
            saveMode: uiEls.modeSelect.value,
            quality: uiEls.qualitySelect.value
          }
        });
      } catch {
        // ignore
      }
    };
    uiEls.modeSelect.addEventListener("change", saveInlineSelects);
    uiEls.qualitySelect.addEventListener("change", saveInlineSelects);

    uiEls.pickDirBtn.addEventListener("click", async () => {
      try {
        const forceNew =
          state.folderPermission === "granted" || state.folderPermission === "missing";
        const handle = await ensureBaseDirectoryHandle(forceNew);
        state.rootDirHandle = handle;
        state.folderPermission = "granted";
        updateFolderBtnLabel(handle.name, "granted");
        const curSettingsRes = await safeStorageGet(["harvesterSettings"]);
        const tpl = curSettingsRes?.harvesterSettings?.folderTemplate || "{title}";
        await refreshExistingStatusOnPanel(tpl);
        if (state.existingStatus === "none") {
          syncUI(`Базовая папка активна: "${handle.name}". Внутри неё создаётся "${meta.title}".`);
        }
      } catch {
        // Пользователь закрыл окно выбора папки
      }
    });

    uiEls.openFolderBtn.addEventListener("click", () => {
      handleOpenDownloadedFolder();
    });

    uiEls.startBtn.addEventListener("click", async (e) => {
      const forceRedownload = Boolean(e.shiftKey);
      const chosenMode = uiEls.modeSelect.value;
      let rootHandle = null;
      if (chosenMode === "folder") {
        try {
          rootHandle = await ensureBaseDirectoryHandle(false);
          state.rootDirHandle = rootHandle;
          state.folderPermission = "granted";
          updateFolderBtnLabel(rootHandle.name, "granted");
        } catch {
          syncUI("Выбор папки отменён");
          return;
        }
      }
      startHarvest(
        {
          startPage: Number(uiEls.startInput.value || 1),
          endPage: Number(uiEls.endInput.value || meta.totalPages),
          saveMode: chosenMode,
          quality: uiEls.qualitySelect.value
        },
        rootHandle,
        forceRedownload
      );
    });

    uiEls.pauseBtn.addEventListener("click", () => {
      if (!state.running) return;
      state.paused = !state.paused;
      syncUI(state.paused ? "На паузе" : "Продолжение загрузки...");
    });

    uiEls.cancelBtn.addEventListener("click", () => {
      if (!state.running) return;
      state.cancelled = true;
      state.paused = false;
      syncUI("Отмена загрузки...");
    });

    if (isReaderPage) {
      const i2 = document.querySelector("#i2");
      if (i2) {
        readerObserver = new MutationObserver(() => {
          if (state.running) return;
          const updatedMeta = detectPageMetadata();
          state.meta = updatedMeta;
          if (uiEls && uiEls.startInput) {
            uiEls.startInput.value = String(updatedMeta.startPage);
          }
        });
        readerObserver.observe(i2, { childList: true, subtree: true, characterData: true });
      }
    }
  }

  const onStorageChanged = (changes, areaName) => {
    if (instanceAborted || areaName !== "local" || !changes.harvesterSettings || !uiEls) return;
    const ns = changes.harvesterSettings.newValue || {};
    if (ns.saveMode) {
      const normalized = ns.saveMode === "picker" ? "folder" : ns.saveMode;
      if (uiEls.modeSelect && uiEls.modeSelect.value !== normalized) {
        uiEls.modeSelect.value = normalized;
      }
    }
    if (ns.quality && uiEls.qualitySelect && uiEls.qualitySelect.value !== ns.quality) {
      uiEls.qualitySelect.value = ns.quality === "original" ? "original" : "webp";
    }
    if (ns.folderTemplate && state.meta && uiEls.folderPreview) {
      const previewSubfolder = buildFolderPath(ns.folderTemplate, state.meta.gid, state.meta.title);
      uiEls.folderPreview.textContent = `Папка манги: ${previewSubfolder}`;
      uiEls.folderPreview.title = previewSubfolder;
    }
  };

  const onRuntimeMessage = (msg, sender, sendResponse) => {
    if (instanceAborted || !msg || !msg.action) return false;

    if (msg.action === "getPageStatus") {
      querySavedDirPermissionStatus().then((dirStatus) => {
        state.folderPermission = dirStatus.state;
        const meta = state.running ? state.meta || detectPageMetadata() : detectPageMetadata();
        state.meta = meta;
        sendResponse({
          supported: true,
          running: state.running,
          paused: state.paused,
          current: state.current,
          total: state.total,
          statusText: state.statusText,
          lastSaveMode: state.lastSaveMode,
          folderPermission: dirStatus.state,
          folderName: dirStatus.name,
          existingStatus: state.existingStatus,
          existingCount: state.existingCount,
          meta
        });
      });
      return true;
    }

    if (msg.action === "startFromPopup") {
      if (msg.options && uiEls) {
        if (msg.options.startPage) uiEls.startInput.value = msg.options.startPage;
        if (msg.options.endPage) uiEls.endInput.value = msg.options.endPage;
        if (msg.options.saveMode) uiEls.modeSelect.value = msg.options.saveMode;
        if (msg.options.quality) uiEls.qualitySelect.value = msg.options.quality;
        if (msg.options.folderTemplate && state.meta) {
          const previewSubfolder = buildFolderPath(
            msg.options.folderTemplate,
            state.meta.gid,
            state.meta.title
          );
          uiEls.folderPreview.textContent = `Папка манги: ${previewSubfolder}`;
          uiEls.folderPreview.title = previewSubfolder;
        }
      }
      startHarvest(msg.options || {}, null, Boolean(msg.forceRedownload));
      sendResponse({ ok: true });
      return true;
    }

    if (msg.action === "focusPickDirFromPopup") {
      highlightButton(
        uiEls?.pickDirBtn,
        "Нажмите подсвеченную кнопку «📁 Куда / Выбрать базовую папку» прямо на странице, чтобы выдать браузеру доступ к диску."
      );
      sendResponse({ ok: true });
      return true;
    }

    if (msg.action === "openFolderFromPopup") {
      handleOpenDownloadedFolder();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.action === "togglePauseFromPopup") {
      if (state.running) {
        state.paused = !state.paused;
        syncUI(state.paused ? "На паузе" : "Продолжение загрузки...");
      }
      sendResponse({ ok: true, paused: state.paused });
      return true;
    }

    if (msg.action === "cancelFromPopup") {
      if (state.running) {
        state.cancelled = true;
        state.paused = false;
      }
      sendResponse({ ok: true });
      return true;
    }

    return false;
  };

  if (isExtensionContextValid()) {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  window.addEventListener(
    "mhs:teardown-previous-instance",
    () => {
      instanceAborted = true;
      state.cancelled = true;
      if (readerObserver) {
        readerObserver.disconnect();
        readerObserver = null;
      }
      try {
        if (isExtensionContextValid()) {
          chrome.runtime.onMessage.removeListener(onRuntimeMessage);
          chrome.storage.onChanged.removeListener(onStorageChanged);
        }
      } catch {
        // ignore
      }
    },
    { once: true }
  );

  mountPanel();
})();
