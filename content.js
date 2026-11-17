(() => {
  // Если в этой вкладке уже работал старый экземпляр скрипта (до перезагрузки расширения в chrome://extensions),
  // посылаем ему сигнал завершения и заменяем панель на живую.
  window.dispatchEvent(new CustomEvent("mhs:teardown-previous-instance"));

  let instanceAborted = false;

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

  // === Реестр скачанных галерей по GID в chrome.storage.local (для мгновенного распознавания дубликатов) ===
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
    try {
      const db = await openHandleDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async function saveRootDirHandle(handle) {
    try {
      const db = await openHandleDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // ignore IDB errors
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
      .map((s) => sanitizeName(s, 95))
      .filter(Boolean);

    let current = rootHandle;
    for (const part of parts) {
      current = await current.getDirectoryHandle(part, { create: true });
    }
    return current;
  }

  // Пытается найти уже существующую подпапку манги БЕЗ её создания
  // (ищет как по точному шаблону, так и по [GID] или названию манги в базовой папке)
  async function findExistingMangaSubfolderHandle(rootHandle, relativeFolderPath, gid, cleanTitle) {
    if (!rootHandle) return null;
    const parts = String(relativeFolderPath || "Manga")
      .replace(/\\/g, "/")
      .split("/")
      .map((s) => sanitizeName(s, 95))
      .filter(Boolean);

    try {
      let current = rootHandle;
      for (const part of parts) {
        current = await current.getDirectoryHandle(part, { create: false });
      }
      return { handle: current, matchedPath: parts.join("/") };
    } catch {
      // Если по текущему шаблону не нашли, проверим альтернативные варианты ([GID] Title или просто Title)
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

  // Сканирование уже существующих файлов в папке манги
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

  // Проверка, есть ли уже готовый .CBZ или .ZIP архив этой манги в базовой папке
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

  // Комплексная проверка: лежит ли уже эта манга в выбранной папке (или в реестре GID)
  async function inspectExistingMangaStatus(meta, folderTemplate) {
    const folderName = buildFolderPath(folderTemplate || "{title}", meta.gid, meta.title);
    const dirStatus = await querySavedDirPermissionStatus();
    state.folderPermission = dirStatus.state;
    if (dirStatus.handle) {
      state.rootDirHandle = dirStatus.handle;
    }

    // 1. Если доступ к папке активен ("granted") — проверяем реальные файлы на диске!
    if (dirStatus.state === "granted" && dirStatus.handle) {
      const foundSub = await findExistingMangaSubfolderHandle(
        dirStatus.handle,
        folderName,
        meta.gid,
        meta.title
      );
      if (foundSub && foundSub.handle) {
        state.lastMangaDirHandle = foundSub.handle;
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

    // 2. Если браузер только запущен и права на папку ещё в состоянии "prompt",
    // проверяем быстрый реестр скачанных GID в chrome.storage.local
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

  // === Встроенный упаковщик PKZIP (STORE = 0 + CRC32 + DOS timestamps + UTF-8) ===
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function buildZipBlob(files, mimeType = "application/zip") {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    const now = new Date();
    const dosTime =
      ((now.getHours() & 0x1f) << 11) |
      ((now.getMinutes() & 0x3f) << 5) |
      ((now.getSeconds() >> 1) & 0x1f);
    const dosDate =
      (((now.getFullYear() - 1980) & 0x7f) << 9) |
      (((now.getMonth() + 1) & 0x0f) << 5) |
      (now.getDate() & 0x1f);

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data));
      const crc = crc32(data);

      const lfh = new Uint8Array(30 + nameBytes.length);
      const lfhView = new DataView(lfh.buffer);
      lfhView.setUint32(0, 0x04034b50, true);
      lfhView.setUint16(4, 20, true);
      lfhView.setUint16(6, 0x0800, true);
      lfhView.setUint16(8, 0, true);
      lfhView.setUint16(10, dosTime, true);
      lfhView.setUint16(12, dosDate, true);
      lfhView.setUint32(14, crc, true);
      lfhView.setUint32(18, data.length, true);
      lfhView.setUint32(22, data.length, true);
      lfhView.setUint16(26, nameBytes.length, true);
      lfh.set(nameBytes, 30);

      const cdh = new Uint8Array(46 + nameBytes.length);
      const cdhView = new DataView(cdh.buffer);
      cdhView.setUint32(0, 0x02014b50, true);
      cdhView.setUint16(4, 20, true);
      cdhView.setUint16(6, 20, true);
      cdhView.setUint16(8, 0x0800, true);
      cdhView.setUint16(10, 0, true);
      cdhView.setUint16(12, dosTime, true);
      cdhView.setUint16(14, dosDate, true);
      cdhView.setUint32(16, crc, true);
      cdhView.setUint32(20, data.length, true);
      cdhView.setUint32(24, data.length, true);
      cdhView.setUint16(28, nameBytes.length, true);
      cdhView.setUint32(42, offset, true);
      cdh.set(nameBytes, 46);

      localParts.push(lfh, data);
      centralParts.push(cdh);
      offset += lfh.length + data.length;
    }

    const cdSize = centralParts.reduce((acc, p) => acc + p.length, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, files.length, true);
    eocdView.setUint16(10, files.length, true);
    eocdView.setUint32(12, cdSize, true);
    eocdView.setUint32(16, offset, true);

    return new Blob([...localParts, ...centralParts, eocd], { type: mimeType });
  }

  function escapeXml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function buildComicInfoXml(meta) {
    const tags = meta.tags || {};
    const writer = [...(tags.artist || []), ...(tags.group || [])].join(", ");
    const series = (tags.parody || []).join(", ") || meta.title;
    const characters = (tags.character || []).join(", ");
    const genre = [...(tags.female || []), ...(tags.male || []), ...(tags.misc || [])].join(", ");
    const langList = tags.language || [];
    let langIso = "ja";
    if (langList.includes("russian")) langIso = "ru";
    else if (langList.includes("english")) langIso = "en";
    else if (langList.includes("chinese")) langIso = "zh";

    const lines = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
      `  <Title>${escapeXml(meta.rawTitle || meta.title)}</Title>`,
      `  <Series>${escapeXml(series)}</Series>`,
      meta.jpTitle ? `  <AlternateSeries>${escapeXml(meta.jpTitle)}</AlternateSeries>` : null,
      writer ? `  <Writer>${escapeXml(writer)}</Writer>` : null,
      characters ? `  <Characters>${escapeXml(characters)}</Characters>` : null,
      genre ? `  <Genre>${escapeXml(genre)}</Genre>` : null,
      `  <PageCount>${Number(meta.totalPages || 0)}</PageCount>`,
      `  <LanguageISO>${escapeXml(langIso)}</LanguageISO>`,
      `  <Manga>YesAndRightToLeft</Manga>`,
      `  <Web>${escapeXml(meta.galleryUrl || window.location.href)}</Web>`,
      `  <Notes>Downloaded with ExManga Harvester Studio v1.9 (GID: ${meta.gid})</Notes>`,
      "</ComicInfo>"
    ].filter(Boolean);

    return new TextEncoder().encode(lines.join("\n"));
  }

  function sanitizeName(str, maxLen = 95) {
    let clean = (str || "Manga")
      .replace(/[\\/:*?"<>|~\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLen)
      .replace(/^[. ]+|[. ]+$/g, "");
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(clean)) {
      clean = `_${clean}`;
    }
    return clean || "Manga";
  }

  function buildFolderPath(template, gid, title) {
    const cleanTitle = sanitizeName(title, 95);
    const raw = (template || "{title}")
      .replace(/\{gid\}/g, String(gid))
      .replace(/\{title\}/g, cleanTitle);
    return raw
      .split("/")
      .map((part) => sanitizeName(part, 95))
      .filter(Boolean)
      .join("/");
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  const path = window.location.pathname;
  const isGalleryPage = path.startsWith("/g/");
  const isReaderPage = path.startsWith("/s/");

  if (!isGalleryPage && !isReaderPage) return;

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
    lastSaveMode: "folder",
    folderPermission: "missing",
    existingStatus: "none", // "none" | "partial_folder" | "complete_folder" | "complete_archive" | "complete_cached"
    existingCount: 0
  };

  function parseInlineScripts(doc = document) {
    const text = Array.from(doc.scripts).map((s) => s.textContent || "").join("\n");
    const gid = Number((text.match(/\bgid\s*=\s*(\d+)/) || [])[1] || 0);
    const token = (text.match(/\btoken\s*=\s*["']([^"']+)["']/) || [])[1] || "";
    const showkey = (text.match(/\bshowkey\s*=\s*["']([^"']+)["']/) || [])[1] || "";
    const startpage = Number((text.match(/\bstartpage\s*=\s*(\d+)/) || [])[1] || 0);
    const startkey = (text.match(/\bstartkey\s*=\s*["']([^"']+)["']/) || [])[1] || "";
    const apiUrl =
      (text.match(/\bapi_url\s*=\s*["']([^"']+)["']/) || [])[1] ||
      `${window.location.origin}/api.php`;
    return { gid, token, showkey, startpage, startkey, apiUrl };
  }

  function parseGalleryTags(doc = document) {
    const tags = {};
    const rows = doc.querySelectorAll("#taglist tr");
    for (const tr of rows) {
      const catCell = tr.querySelector("td.tc");
      if (!catCell) continue;
      const cat = catCell.textContent.replace(/:/g, "").trim().toLowerCase();
      const values = Array.from(tr.querySelectorAll("td div a")).map((a) =>
        a.textContent.trim()
      );
      if (cat && values.length > 0) {
        tags[cat] = values;
      }
    }
    return tags;
  }

  function computeGalleryPagination(doc = document, currentUrl = window.location.href) {
    const gpcText = doc.querySelector(".gpc")?.textContent || "";
    let totalPages = 0;
    let perPage = 0;

    const rangeMatch = gpcText.match(/Showing\s+([\d,]+)\s*-\s*([\d,]+)\s+of\s+([\d,]+)\s+images/i);
    if (rangeMatch) {
      const startIdx = Number(rangeMatch[1].replace(/,/g, ""));
      const endIdx = Number(rangeMatch[2].replace(/,/g, ""));
      totalPages = Number(rangeMatch[3].replace(/,/g, ""));

      let currentP = 0;
      try {
        currentP = Number(new URL(currentUrl, window.location.origin).searchParams.get("p") || 0);
      } catch {
        currentP = 0;
      }

      if (currentP > 0 && startIdx > 1) {
        perPage = Math.round((startIdx - 1) / currentP);
      } else {
        perPage = endIdx - startIdx + 1;
      }
    } else {
      const gpcMatch = gpcText.match(/of\s+([\d,]+)\s+images/i);
      if (gpcMatch) {
        totalPages = Number(gpcMatch[1].replace(/,/g, ""));
      }
    }

    if (!totalPages) {
      const gddCells = Array.from(doc.querySelectorAll("#gdd td.gdt2"));
      for (const td of gddCells) {
        const m = (td.textContent || "").match(/^([\d,]+)\s+pages/i);
        if (m) {
          totalPages = Number(m[1].replace(/,/g, ""));
          break;
        }
      }
    }

    const thumbsCount = doc.querySelectorAll("#gdt a[href*='/s/']").length;
    if (!perPage) {
      perPage = thumbsCount || 20;
    }

    return {
      totalPages: totalPages || thumbsCount || 1,
      perPage: perPage || 20
    };
  }

  function detectPageMetadata() {
    const vars = parseInlineScripts(document);
    const url = window.location.href;

    if (isGalleryPage) {
      const urlMatch = url.match(/\/g\/(\d+)\/([a-f0-9]+)/i);
      const gid = vars.gid || (urlMatch ? Number(urlMatch[1]) : 0);
      const token = vars.token || (urlMatch ? urlMatch[2] : "");

      const rawTitle =
        document.querySelector("#gn")?.textContent?.trim() ||
        document.querySelector("#gj")?.textContent?.trim() ||
        document.title.replace(/\s*-\s*(ExHentai\.org|E-Hentai Galleries).*$/i, "");
      const jpTitle = document.querySelector("#gj")?.textContent?.trim() || "";

      const { totalPages, perPage } = computeGalleryPagination(document, url);
      const tags = parseGalleryTags(document);

      return {
        mode: "gallery",
        gid,
        token,
        apiUrl: vars.apiUrl,
        rawTitle,
        jpTitle,
        tags,
        galleryUrl: `${window.location.origin}/g/${gid}/${token}/`,
        title: sanitizeName(rawTitle),
        totalPages,
        startPage: 1,
        perPage
      };
    } else {
      const urlMatch = window.location.pathname.match(/\/s\/([a-f0-9]+)\/(\d+)-(\d+)/i);
      const startkey = (urlMatch ? urlMatch[1] : "") || vars.startkey || "";
      const gid = (urlMatch ? Number(urlMatch[2]) : 0) || vars.gid || 0;
      const urlPage = urlMatch ? Number(urlMatch[3]) : 0;

      const backHref = document.querySelector("#i5 a")?.getAttribute("href") || "";
      const backMatch = backHref.match(/\/g\/(\d+)\/([a-f0-9]+)/i);
      const token = vars.token || (backMatch ? backMatch[2] : "");

      const rawTitle =
        document.querySelector("#i1 h1")?.textContent?.trim() ||
        document.querySelector("h1")?.textContent?.trim() ||
        document.title.replace(/\s*-\s*(ExHentai\.org|E-Hentai Galleries).*$/i, "");

      const snSpans = document.querySelectorAll(".sn div span");
      const domCurrentPage = Number(snSpans[0]?.textContent || 0);
      const domTotalPages = Number(snSpans[1]?.textContent || 0);

      const currentPage = domCurrentPage || urlPage || vars.startpage || 1;
      const totalPages = domTotalPages || currentPage || 1;

      return {
        mode: "reader",
        gid,
        token,
        showkey: vars.showkey,
        startkey,
        apiUrl: vars.apiUrl,
        rawTitle,
        jpTitle: "",
        tags: {},
        galleryUrl: token ? `${window.location.origin}/g/${gid}/${token}/` : window.location.href,
        title: sanitizeName(rawTitle),
        totalPages,
        startPage: currentPage,
        perPage: 0
      };
    }
  }

  function decodeHtmlEntities(str) {
    if (!str) return "";
    return str.replace(/&amp;/g, "&");
  }

  function parseReaderFragments(i3Html, i6Html, i7Html = "", nHtml = "") {
    const combinedBottom = `${i6Html || ""}\n${i7Html || ""}`;
    const combinedNav = `${i3Html || ""}\n${nHtml || ""}`;

    const srcMatch =
      (i3Html || "").match(/id=["']img["'][^>]*src=["']([^"']+)["']/i) ||
      (i3Html || "").match(/src=["']([^"']+)["'][^>]*id=["']img["']/i);
    const imgUrl = srcMatch ? decodeHtmlEntities(srcMatch[1]) : "";

    let nextMatch = (i3Html || "").match(/load_image\(\s*(\d+)\s*,\s*['"]([a-f0-9]+)['"]\s*\)/i);
    if (!nextMatch && nHtml) {
      const nextTagMatch =
        nHtml.match(/id=["']next["'][^>]*onclick=["'][^"']*load_image\(\s*(\d+)\s*,\s*['"]([a-f0-9]+)['"]\s*\)/i) ||
        nHtml.match(/onclick=["'][^"']*load_image\(\s*(\d+)\s*,\s*['"]([a-f0-9]+)['"]\s*\)[^"']*["'][^>]*id=["']next["']/i);
      if (nextTagMatch) nextMatch = nextTagMatch;
    }
    const nextPage = nextMatch ? Number(nextMatch[1]) : null;
    const nextImgKey = nextMatch ? nextMatch[2] : null;

    const nlMatch =
      combinedNav.match(/nl\(\s*['"]([^'"]+)['"]\s*\)/i) ||
      combinedBottom.match(/nl\(\s*['"]([^'"]+)['"]\s*\)/i);
    const nlToken = nlMatch ? nlMatch[1] : null;

    const fullMatch = combinedBottom.match(/href=["']([^"']*fullimg[^"']+)["']/i);
    let fullImgUrl = fullMatch ? decodeHtmlEntities(fullMatch[1]) : "";
    if (fullImgUrl && !/^https?:\/\//i.test(fullImgUrl)) {
      try {
        fullImgUrl = new URL(fullImgUrl, window.location.origin).href;
      } catch {
        // ignore
      }
    }

    return { imgUrl, fullImgUrl, nextPage, nextImgKey, nlToken };
  }

  function parseFullReaderDocument(htmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText, "text/html");
    const vars = parseInlineScripts(doc);

    if (!vars.showkey) {
      const skMatch = htmlText.match(/\bshowkey\s*=\s*["']([^"']+)["']/i);
      if (skMatch) vars.showkey = skMatch[1];
    }

    const i3Html = doc.querySelector("#i3")?.innerHTML || "";
    const i6Html = doc.querySelector("#i6")?.innerHTML || "";
    const i7Html = doc.querySelector("#i7")?.innerHTML || "";
    const i2Html = doc.querySelector("#i2")?.innerHTML || "";
    const parsed = parseReaderFragments(i3Html, i6Html, i7Html, i2Html);

    if (!parsed.nextImgKey) {
      const nextA = doc.querySelector("#next")?.getAttribute("onclick") || "";
      const m = nextA.match(/load_image\(\s*(\d+)\s*,\s*['"]([a-f0-9]+)['"]\s*\)/i);
      if (m) {
        parsed.nextPage = Number(m[1]);
        parsed.nextImgKey = m[2];
      }
    }
    return { ...vars, ...parsed, i2Html };
  }

  function findReaderLinkInGalleryDoc(doc, gid, targetPage) {
    const re = new RegExp(`/s/([a-f0-9]+)/${gid}-${targetPage}(?:\\b|$)`, "i");
    const links = Array.from(doc.querySelectorAll("#gdt a[href*='/s/'], a[href*='/s/']"));
    for (const a of links) {
      const href = a.getAttribute("href") || a.href || "";
      if (re.test(href)) {
        return new URL(href, window.location.origin).href;
      }
    }
    return null;
  }

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
      const p0Res = await fetch(p0Url, { credentials: "include" });
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
    const res = await fetch(galleryUrl, { credentials: "include" });
    if (!res.ok) throw new Error(`Не удалось загрузить лист галереи ?p=${pageIndex}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const found = findReaderLinkInGalleryDoc(doc, meta.gid, targetPage);
    if (found) return found;

    throw new Error(`Не найдена ссылка на страницу #${targetPage} на листе галереи ?p=${pageIndex}`);
  }

  function extractOriginalBaseName(url, contentType, fallbackIndex) {
    let extFromMime = "";
    if (contentType) {
      if (contentType.includes("webp")) extFromMime = "webp";
      else if (contentType.includes("jpeg") || contentType.includes("jpg")) extFromMime = "jpg";
      else if (contentType.includes("png")) extFromMime = "png";
      else if (contentType.includes("gif")) extFromMime = "gif";
    }
    try {
      const clean = (url || "").split("?")[0].split(";")[0];
      const last = decodeURIComponent(clean.substring(clean.lastIndexOf("/") + 1));
      if (!last || last === "fullimg.php" || last === "fullimg") {
        return { stem: `page_${fallbackIndex}`, ext: extFromMime || "jpg" };
      }
      const dot = last.lastIndexOf(".");
      const stem = dot > 0 ? last.substring(0, dot) : last;
      let ext = dot > 0 ? last.substring(dot + 1).toLowerCase() : (extFromMime || "webp");
      if (ext === "wbp") ext = "webp";
      if (!["webp", "jpg", "jpeg", "png", "gif", "bmp", "avif"].includes(ext)) {
        ext = extFromMime || "webp";
      }
      return { stem: sanitizeName(stem || `page_${fallbackIndex}`, 60), ext };
    } catch {
      return { stem: `page_${fallbackIndex}`, ext: extFromMime || "webp" };
    }
  }

  function formatEntryName(pageNumber, totalPages, origStem, ext, template) {
    const padWidth = Math.max(3, String(totalPages).length);
    const pagePad = String(pageNumber).padStart(padWidth, "0");
    if (template === "{page_pad}") {
      return `${pagePad}.${ext}`;
    }
    return `${pagePad}_${origStem}.${ext}`;
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
        return { resp, usedUrl: resp.finalUrl || targetUrl, info, usedFallback: forceCompressedFallback };
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
        const fallbackReaderUrl = `${window.location.origin}/s/${imgKey}/${gid}-${pageNumber}?nl=${encodeURIComponent(info.nlToken)}`;
        const nlRes = await fetch(fallbackReaderUrl, { credentials: "include" });
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

  // Сохранение собранного архива (.CBZ / .ZIP) напрямую в выбранную базовую папку манги (если она выбрана)
  // или через менеджер загрузок браузера
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

    // Если у нас есть доступ к выбранной базовой папке — сохраняем архив прямо туда!
    const activeRoot = rootHandle || state.rootDirHandle;
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
        // Если не удалось записать напрямую — используем штатное скачивание ниже
      }
    }

    const blobUrl = URL.createObjectURL(zipBlob);
    try {
      const dlResp = await safeRuntimeMessage({
        action: "downloadArchiveBlobUrl",
        blobUrl,
        filename: archiveFileName
      });
      if (dlResp && dlResp.ok) {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        return { savedInRootDir: false };
      }
    } catch {
      // Fallback на <a download>
    }

    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = archiveFileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    return { savedInRootDir: false };
  }

  // === ОТКРЫТИЕ ПАПКИ МАНГИ (без ухода в системные «Загрузки»!) ===
  async function handleOpenDownloadedFolder() {
    try {
      // 1. Получаем сохранённую базовую папку, куда пользователь сохраняет мангу
      let rootHandle = state.rootDirHandle || (await getSavedRootDirHandle());
      if (rootHandle) {
        let perm = await rootHandle.queryPermission({ mode: "readwrite" });
        if (perm !== "granted") {
          perm = await rootHandle.requestPermission({ mode: "readwrite" });
        }
        if (perm === "granted") {
          state.rootDirHandle = rootHandle;
          state.folderPermission = "granted";
          updateFolderBtnLabel(rootHandle.name, "granted");

          // Проверяем, есть ли уже созданная подпапка для текущей манги
          let targetDirToOpen = state.lastMangaDirHandle;
          if (!targetDirToOpen && state.meta) {
            const stored = await safeStorageGet(["harvesterSettings"]);
            const tpl = stored?.harvesterSettings?.folderTemplate || "{title}";
            const folderName = buildFolderPath(tpl, state.meta.gid, state.meta.title);
            const foundSub = await findExistingMangaSubfolderHandle(
              rootHandle,
              folderName,
              state.meta.gid,
              state.meta.title
            );
            if (foundSub && foundSub.handle) {
              targetDirToOpen = foundSub.handle;
              state.lastMangaDirHandle = foundSub.handle;
            }
          }

          // Открываем нативное окно Проводника прямо внутри папки манги (или базовой папки манги, если эта глава ещё не скачана)
          await window.showDirectoryPicker({
            startIn: targetDirToOpen || rootHandle,
            mode: "readwrite"
          });
          return;
        }
      }
    } catch (err) {
      // Если пользователь просто закрыл диалог Проводника (AbortError) — ничего больше делать не нужно
      if (err && err.name === "AbortError") {
        return;
      }
      if (err && err.name === "SecurityError") {
        highlightButton(
          uiEls?.openFolderBtn,
          "Нажмите кнопку «📂 Открыть папку» прямо на панели страницы, чтобы открыть вашу папку манги."
        );
        return;
      }
    }

    // Фоллбэк на системные «Загрузки» ТОЛЬКО если пользователь вообще не выбирал свою базовую папку
    const preferShowLastFile = state.lastSaveMode === "cbz" || state.lastSaveMode === "zip";
    try {
      await safeRuntimeMessage({
        action: "openDownloadsFolder",
        preferShowLastFile
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

    // Получаем доступ к базовой папке (для режима folder — обязательно, для cbz/zip — если она уже была выбрана)
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
    // Если не зажат Shift (forceRedownload === false) и включён Smart Resume — проверяем, не лежит ли уже эта манга в папке!
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
          existingPagesMap = await scanExistingPagePrefixes(existingSub.handle);

          // Считаем, сколько страниц из запрошенного диапазона [startPage..endPage] уже лежит в папке
          let alreadyHaveInRange = 0;
          for (let p = startPage; p <= endPage; p++) {
            if (existingPagesMap.has(p)) alreadyHaveInRange++;
          }

          if (alreadyHaveInRange >= totalToDownload) {
            state.existingStatus = "complete_folder";
            state.existingCount = existingPagesMap.size;
            state.current = totalToDownload;
            state.total = totalToDownload;
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
      if (!forceRedownload && settings.smartResume !== false) {
        existingPagesMap = await scanExistingPagePrefixes(targetMangaDirHandle);
      }
    }

    state.running = true;
    state.paused = false;
    state.cancelled = false;
    state.current = 0;
    state.total = totalToDownload;
    syncUI("Инициализация стартовой страницы...");

    const collectedFiles = [];
    let lastCompletedPage = startPage - 1;
    let skippedCount = 0;

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

        // Smart Resume: если страница уже есть в папке — пропускаем её
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

            const firstRes = await fetch(readerUrl, { credentials: "include" });
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

        const bin = atob(resp.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        if (settings.saveMode === "folder" && targetMangaDirHandle) {
          const fileHandle = await targetMangaDirHandle.getFileHandle(entryFileName, {
            create: true
          });
          const writable = await fileHandle.createWritable();
          await writable.write(bytes);
          await writable.close();
        } else {
          collectedFiles.push({ name: entryFileName, data: bytes });
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
        const apiRes = await fetch(apiUrl, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: "showpage",
            gid: Number(gid),
            page: Number(nextPage),
            imgkey: nextImgKey,
            showkey
          })
        });

        if (!apiRes.ok) {
          throw new Error(`Ошибка ответа API на странице ${nextPage}: HTTP ${apiRes.status}`);
        }
        const data = await apiRes.json();
        if (data.error) {
          throw new Error(`API вернул ошибку: ${data.error}`);
        }

        currentImgKey = nextImgKey;
        currentInfo = parseReaderFragments(
          data.i3 || "",
          data.i6 || "",
          data.i7 || "",
          data.n || ""
        );
      }

      if (settings.saveMode === "cbz" || settings.saveMode === "zip") {
        if (collectedFiles.length > 0) {
          const ext = settings.saveMode === "cbz" ? "cbz" : "zip";
          const rangeSuffix =
            startPage === 1 && endPage === meta.totalPages ? "" : `_p${startPage}-${endPage}`;
          const archiveName = `${meta.title}${rangeSuffix}.${ext}`;

          syncUI(
            `Упаковка ${collectedFiles.length} страниц в единый ${ext.toUpperCase()}-архив...`
          );
          const saveRes = await saveArchiveToDisk(
            collectedFiles,
            meta,
            settings,
            archiveName,
            rootHandle
          );
          state.existingStatus = "complete_archive";
          state.existingCount = collectedFiles.length;
          await saveDownloadedGalleryRecord(meta.gid, {
            title: meta.title,
            archiveName,
            pagesCount: collectedFiles.length,
            totalPages: meta.totalPages,
            complete: startPage === 1 && endPage === meta.totalPages
          });
          applyExistingBadgeUI();

          const whereText = saveRes.savedInRootDir
            ? `в папку "${saveRes.dirName}/${archiveName}"`
            : `как "${archiveName}"`;
          syncUI(
            `✅ Архив сохранён ${whereText} (${collectedFiles.length} стр.)! Нажмите «📂 Открыть папку».`
          );
        }
      } else {
        if (settings.includeComicInfo !== false && targetMangaDirHandle) {
          try {
            const ciHandle = await targetMangaDirHandle.getFileHandle("ComicInfo.xml", {
              create: true
            });
            const ciWritable = await ciHandle.createWritable();
            await ciWritable.write(buildComicInfoXml(meta));
            await ciWritable.close();
          } catch {
            // ignore ComicInfo write errors
          }
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
          <span>ExManga Harvester v1.9</span>
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
          <button class="mhs-btn mhs-btn-secondary" id="mhs-btn-openfolder" title="Открыть именно ту папку, куда сохраняется манга (подпапку манги или вашу базовую папку)">📂 Открыть папку</button>
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

    // Сразу при загрузке страницы проверяем, не скачана ли уже эта манга!
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
        await refreshExistingStatusOnPanel(s.folderTemplate || "{title}");
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
      // Поскольку открытие кастомной папки через File System Access API требует клика на самой странице,
      // пробуем открыть сразу, а если браузер требует User Gesture — подсвечиваем кнопку «📂 Открыть папку» на панели!
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
        }
      } catch {
        // ignore
      }
    },
    { once: true }
  );

  mountPanel();
})();
