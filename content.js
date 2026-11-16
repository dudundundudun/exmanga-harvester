(() => {
  if (window.__EXMANGA_HARVESTER_V18__) return;
  window.__EXMANGA_HARVESTER_V18__ = true;

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
        } catch {
          // Если старый дескриптор устарел — откроем выбор папки заново
        }
      }
    }

    const picked = await window.showDirectoryPicker({
      id: "exmanga_root_dir",
      mode: "readwrite",
      startIn: "downloads"
    });
    await saveRootDirHandle(picked);
    return picked;
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
      const data = file.data;
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
    lastSaveMode: "folder"
  };

  function parseInlineScripts(doc = document) {
    const text = Array.from(doc.scripts).map((s) => s.textContent || "").join("\n");
    const gid = Number((text.match(/\bgid\s*=\s*(\d+)/) || [])[1] || 0);
    const token = (text.match(/\btoken\s*=\s*["']([^"']+)["']/) || [])[1] || "";
    const showkey = (text.match(/\bshowkey\s*=\s*["']([^"']+)["']/) || [])[1] || "";
    const startpage = Number((text.match(/\bstartpage\s*=\s*(\d+)/) || [])[1] || 0);
    const startkey = (text.match(/\bstartkey\s*=\s*["']([^"']+)["']/) || [])[1] || "";
    const apiUrl = (text.match(/\bapi_url\s*=\s*["']([^"']+)["']/) || [])[1] || `${window.location.origin}/api.php`;
    return { gid, token, showkey, startpage, startkey, apiUrl };
  }

  function detectPageMetadata() {
    const vars = parseInlineScripts(document);
    const url = window.location.href;

    if (isGalleryPage) {
      const urlMatch = url.match(/\/g\/(\d+)\/([a-f0-9]+)/i);
      const gid = vars.gid || (urlMatch ? Number(urlMatch[1]) : 0);
      const token = vars.token || (urlMatch ? urlMatch[2] : "");

      const title =
        document.querySelector("#gn")?.textContent?.trim() ||
        document.querySelector("#gj")?.textContent?.trim() ||
        document.title.replace(/\s*-\s*(ExHentai\.org|E-Hentai Galleries).*$/i, "");

      let totalPages = 0;
      const gpcText = document.querySelector(".gpc")?.textContent || "";
      const gpcMatch = gpcText.match(/of\s+([\d,]+)\s+images/i);
      if (gpcMatch) {
        totalPages = Number(gpcMatch[1].replace(/,/g, ""));
      }
      if (!totalPages) {
        const gddCells = Array.from(document.querySelectorAll("#gdd td.gdt2"));
        for (const td of gddCells) {
          const m = (td.textContent || "").match(/^([\d,]+)\s+pages/i);
          if (m) {
            totalPages = Number(m[1].replace(/,/g, ""));
            break;
          }
        }
      }

      const thumbs = Array.from(document.querySelectorAll("#gdt a[href*='/s/']"));
      const perPage = thumbs.length || 20;

      return {
        mode: "gallery",
        gid,
        token,
        apiUrl: vars.apiUrl,
        title: sanitizeName(title),
        totalPages: totalPages || thumbs.length || 1,
        startPage: 1,
        perPage
      };
    } else {
      const urlMatch = url.match(/\/s\/([a-f0-9]+)\/(\d+)-(\d+)/i);
      const startkey = vars.startkey || (urlMatch ? urlMatch[1] : "");
      const gid = vars.gid || (urlMatch ? Number(urlMatch[2]) : 0);
      const urlPage = urlMatch ? Number(urlMatch[3]) : 1;

      const backHref = document.querySelector("#i5 a")?.getAttribute("href") || "";
      const backMatch = backHref.match(/\/g\/(\d+)\/([a-f0-9]+)/i);
      const token = vars.token || (backMatch ? backMatch[2] : "");

      const title =
        document.querySelector("#i1 h1")?.textContent?.trim() ||
        document.querySelector("h1")?.textContent?.trim() ||
        document.title.replace(/\s*-\s*(ExHentai\.org|E-Hentai Galleries).*$/i, "");

      const snSpans = document.querySelectorAll(".sn div span");
      const currentPage = vars.startpage || Number(snSpans[0]?.textContent || urlPage || 1);
      const totalPages = Number(snSpans[1]?.textContent || currentPage || 1);

      return {
        mode: "reader",
        gid,
        token,
        showkey: vars.showkey,
        startkey,
        apiUrl: vars.apiUrl,
        title: sanitizeName(title),
        totalPages,
        startPage: currentPage,
        perPage: 0
      };
    }
  }

  function parseReaderFragments(i3Html, i6Html, i7Html = "", nHtml = "") {
    const combinedBottom = `${i6Html || ""}\n${i7Html || ""}`;
    const combinedNav = `${i3Html || ""}\n${nHtml || ""}`;

    const srcMatch =
      (i3Html || "").match(/id=["']img["'][^>]*src=["']([^"']+)["']/i) ||
      (i3Html || "").match(/src=["']([^"']+)["'][^>]*id=["']img["']/i);
    const imgUrl = srcMatch ? srcMatch[1].replace(/&amp;/g, "&") : "";

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
    const fullImgUrl = fullMatch ? fullMatch[1].replace(/&amp;/g, "&") : "";

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
      const m = window.location.href.match(/\/s\/([a-f0-9]+)\/(\d+)-(\d+)/i);
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
      const foundOnP0 = findReaderLinkInGalleryDoc(p0Doc, meta.gid, targetPage);
      if (foundOnP0) return foundOnP0;

      const thumbsCount = p0Doc.querySelectorAll("#gdt a[href*='/s/']").length;
      perPage = thumbsCount || 20;
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

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const useOriginal = Boolean(settings.quality === "original" && info.fullImgUrl);
      const targetUrl = useOriginal ? info.fullImgUrl : info.imgUrl;

      if (!targetUrl) {
        throw new Error(`Не найден URL изображения на странице ${pageNumber}`);
      }

      const resp = await chrome.runtime.sendMessage({
        action: "fetchImageBytes",
        url: targetUrl,
        includeCredentials: useOriginal
      });

      if (resp && resp.ok && resp.base64) {
        return { resp, usedUrl: resp.finalUrl || targetUrl, info };
      }

      if (attempt < maxRetries && info.nlToken && imgKey) {
        updateStatus(
          `Сбой узла на стр. ${pageNumber} (${resp?.error || "ошибка"}). Смена зеркала nl (${attempt + 1}/${maxRetries})...`
        );
        await sleep(1000);
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
        await sleep(1000);
      } else {
        throw new Error(`Сбой скачивания страницы ${pageNumber}: ${resp?.error || "нет ответа"}`);
      }
    }
  }

  async function waitWhilePaused() {
    while (state.paused && !state.cancelled) {
      await sleep(250);
    }
  }

  // Открытие папки со скачанной мангой
  async function handleOpenDownloadedFolder(shiftKey = false) {
    // Если зажат Shift (или базовая папка выбрана вне Загрузок и пользователь хочет открыть именно подпапку манги через диалог)
    if (shiftKey && (state.lastMangaDirHandle || state.rootDirHandle)) {
      try {
        await window.showDirectoryPicker({
          startIn: state.lastMangaDirHandle || state.rootDirHandle,
          mode: "read"
        });
        return;
      } catch {
        return;
      }
    }

    const preferShowLastFile = state.lastSaveMode === "cbz" || state.lastSaveMode === "zip";
    await chrome.runtime.sendMessage({
      action: "openDownloadsFolder",
      preferShowLastFile
    });
  }

  async function startHarvest(customOptions = {}, preAcquiredRootDirHandle = null) {
    if (state.running) return;
    const meta = detectPageMetadata();
    state.meta = meta;

    const stored = await chrome.storage.local.get(["harvesterSettings"]);
    const settings = {
      saveMode: "folder",
      quality: "webp",
      delayMs: 1200,
      maxRetries: 3,
      folderTemplate: "{title}",
      fileTemplate: "{page_pad}_{orig_name}",
      ...(stored.harvesterSettings || {}),
      ...customOptions
    };

    if (settings.saveMode === "picker") {
      settings.saveMode = "folder";
    }
    state.lastSaveMode = settings.saveMode;

    await chrome.storage.local.set({
      harvesterSettings: {
        saveMode: settings.saveMode,
        quality: settings.quality,
        delayMs: settings.delayMs,
        maxRetries: settings.maxRetries,
        folderTemplate: settings.folderTemplate,
        fileTemplate: settings.fileTemplate
      }
    });

    const startPage = Math.max(1, Math.min(meta.totalPages, Number(settings.startPage || 1)));
    const endPage = Math.max(startPage, Math.min(meta.totalPages, Number(settings.endPage || meta.totalPages)));
    const totalToDownload = endPage - startPage + 1;
    const folderName = buildFolderPath(settings.folderTemplate || "{title}", meta.gid, meta.title);

    let targetMangaDirHandle = null;
    let rootDirName = "";
    if (settings.saveMode === "folder") {
      try {
        const rootHandle = preAcquiredRootDirHandle || (await ensureBaseDirectoryHandle(false));
        state.rootDirHandle = rootHandle;
        rootDirName = rootHandle.name || "Выбранная папка";
        updateFolderBtnLabel(rootDirName);
        targetMangaDirHandle = await getOrCreateSubfolderHandle(rootHandle, folderName);
        state.lastMangaDirHandle = targetMangaDirHandle;
      } catch (err) {
        syncUI(
          "Чтобы скачать в папку без 500 окон Проводника, нажмите кнопку «Скачать» прямо на панели страницы и выберите базовую папку 1 раз."
        );
        return;
      }
    }

    state.running = true;
    state.paused = false;
    state.cancelled = false;
    state.current = 0;
    state.total = totalToDownload;
    syncUI("Инициализация стартовой страницы...");

    try {
      let gid = meta.gid;
      let apiUrl = meta.apiUrl;
      let showkey = meta.showkey;
      let currentImgKey = meta.startkey;
      let currentInfo = null;

      if (isGalleryPage || startPage !== meta.startPage || !showkey) {
        syncUI(`Получение ключей стартовой страницы #${startPage}...`);
        const readerUrl = await resolveReaderUrlForPage(startPage, meta);
        const keyMatch = readerUrl.match(/\/s\/([a-f0-9]+)\/(\d+)-(\d+)/i);
        if (keyMatch) currentImgKey = keyMatch[1];

        const firstRes = await fetch(readerUrl, { credentials: "include" });
        if (!firstRes.ok) throw new Error(`Ошибка загрузки страницы ридера #${startPage}`);
        const firstHtml = await firstRes.text();
        const parsedFirst = parseFullReaderDocument(firstHtml);
        gid = parsedFirst.gid || gid;
        showkey = parsedFirst.showkey || showkey;
        apiUrl = parsedFirst.apiUrl || apiUrl;
        currentInfo = parsedFirst;
      } else {
        const i3Html = document.querySelector("#i3")?.innerHTML || "";
        const i6Html = document.querySelector("#i6")?.innerHTML || "";
        const i7Html = document.querySelector("#i7")?.innerHTML || "";
        const i2Html = document.querySelector("#i2")?.innerHTML || "";
        currentInfo = parseReaderFragments(i3Html, i6Html, i7Html, i2Html);
      }

      if (!showkey && startPage < endPage) {
        throw new Error("Не удалось извлечь showkey со страницы ридера");
      }

      const collectedFiles = [];

      for (let page = startPage; page <= endPage; page++) {
        await waitWhilePaused();
        if (state.cancelled) {
          throw new Error("Загрузка отменена пользователем");
        }

        const stepIndex = page - startPage + 1;
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
        const entryFileName = formatEntryName(page, meta.totalPages, stem, ext, settings.fileTemplate);

        const bin = atob(resp.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        if (settings.saveMode === "folder" && targetMangaDirHandle) {
          const fileHandle = await targetMangaDirHandle.getFileHandle(entryFileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(bytes);
          await writable.close();
        } else {
          collectedFiles.push({ name: entryFileName, data: bytes });
        }

        state.current = stepIndex;
        syncUI(`Готово ${stepIndex} из ${totalToDownload} (${folderName}/${entryFileName})`);

        if (page >= endPage) break;

        let nextImgKey = currentInfo.nextImgKey;
        const nextPage = page + 1;

        if (!nextImgKey) {
          const nextReaderUrl = await resolveReaderUrlForPage(nextPage, meta);
          const m = nextReaderUrl.match(/\/s\/([a-f0-9]+)\/(\d+)-(\d+)/i);
          if (m) nextImgKey = m[1];
        }
        if (!nextImgKey) {
          throw new Error(`Не найден ключ следующей страницы после стр. ${page}`);
        }

        await waitWhilePaused();
        if (state.cancelled) {
          throw new Error("Загрузка отменена пользователем");
        }

        const delay = Math.max(1050, Number(settings.delayMs || 1200));
        await sleep(delay);

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
        currentInfo = parseReaderFragments(data.i3 || "", data.i6 || "", data.i7 || "", data.n || "");
      }

      if (settings.saveMode === "cbz" || settings.saveMode === "zip") {
        if (collectedFiles.length > 0) {
          syncUI(`Упаковка ${collectedFiles.length} страниц в единый ${settings.saveMode.toUpperCase()}-архив...`);
          const isCbz = settings.saveMode === "cbz";
          const zipBlob = buildZipBlob(
            collectedFiles,
            isCbz ? "application/vnd.comicbook+zip" : "application/zip"
          );
          const ext = isCbz ? "cbz" : "zip";
          const rangeSuffix = startPage === 1 && endPage === meta.totalPages ? "" : `_p${startPage}-${endPage}`;
          const archiveName = `${meta.title}${rangeSuffix}.${ext}`;

          const blobUrl = URL.createObjectURL(zipBlob);
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = archiveName;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
          syncUI(`Архив "${archiveName}" (${collectedFiles.length} стр.) сохранён! Нажмите «📂 Открыть папку».`);
        }
      } else {
        syncUI(`Готово! Все ${totalToDownload} стр. сохранены в "${rootDirName}/${folderName}". Нажмите «📂 Открыть папку».`);
      }
    } catch (err) {
      syncUI(`Остановлено: ${err.message || String(err)}`);
    } finally {
      state.running = false;
      state.paused = false;
      syncUI(state.statusText);
    }
  }

  let uiEls = null;

  function updateFolderBtnLabel(dirName) {
    if (!uiEls || !uiEls.pickDirBtn) return;
    uiEls.pickDirBtn.textContent = dirName ? `📁 Куда: ${dirName}` : "📁 Выбрать базовую папку";
    uiEls.pickDirBtn.title = dirName
      ? `Текущая базовая папка: ${dirName} (внутри неё создаётся папка с названием манги). Нажмите, чтобы сменить.`
      : "Выберите общую папку 1 раз — внутри неё будет автоматически создаваться папка для каждой манги без окон Проводника";
  }

  function syncUI(statusText) {
    if (statusText) state.statusText = statusText;
    if (!uiEls) return;
    const pct = state.total > 0 ? Math.round((state.current / state.total) * 100) : 0;
    uiEls.progressWrap.classList.toggle("active", state.running || state.current > 0);
    uiEls.progressFill.style.width = `${pct}%`;
    uiEls.statusLabel.textContent = state.statusText;
    uiEls.counterLabel.textContent = state.total > 0 ? `${state.current} / ${state.total} (${pct}%)` : "";
    uiEls.startBtn.disabled = state.running;
    uiEls.pauseBtn.disabled = !state.running;
    uiEls.pauseBtn.textContent = state.paused ? "Продолжить" : "Пауза";
    uiEls.cancelBtn.disabled = !state.running;
  }

  async function mountPanel() {
    if (document.getElementById("mhs-root-panel")) return;
    const meta = detectPageMetadata();
    state.meta = meta;
    const stored = await chrome.storage.local.get(["harvesterSettings"]);
    const s = stored.harvesterSettings || {};
    const curMode = s.saveMode === "picker" ? "folder" : (s.saveMode || "folder");
    state.lastSaveMode = curMode;
    const savedHandle = await getSavedRootDirHandle();
    if (savedHandle) state.rootDirHandle = savedHandle;

    const panel = document.createElement("div");
    panel.id = "mhs-root-panel";
    panel.className = `mhs-panel ${isReaderPage ? "mhs-reader-floating" : ""}`;
    panel.innerHTML = `
      <div class="mhs-header">
        <div class="mhs-title">
          <span>ExManga Harvester</span>
          <span class="mhs-badge">GID: ${meta.gid} • ${meta.totalPages} стр.</span>
        </div>
        <div style="font-size:12px;color:#9aa0a6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:440px;" title="${meta.title}">
          Папка манги: ${meta.title}
        </div>
      </div>
      <div class="mhs-controls">
        <div class="mhs-field">
          <label>Страницы:</label>
          <input type="number" class="mhs-input" id="mhs-start" min="1" max="${meta.totalPages}" value="${meta.startPage}" />
          <span>—</span>
          <input type="number" class="mhs-input" id="mhs-end" min="1" max="${meta.totalPages}" value="${meta.totalPages}" />
        </div>
        <div class="mhs-field">
          <label>Формат:</label>
          <select class="mhs-select" id="mhs-mode">
            <option value="folder" ${curMode === "folder" ? "selected" : ""}>В папку &lt;Название манги&gt; (без окон)</option>
            <option value="cbz" ${curMode === "cbz" ? "selected" : ""}>Единый .CBZ архив</option>
            <option value="zip" ${curMode === "zip" ? "selected" : ""}>Единый .ZIP архив</option>
          </select>
        </div>
        <div class="mhs-field">
          <button type="button" class="mhs-btn mhs-btn-secondary" id="mhs-btn-pickdir"></button>
        </div>
        <div class="mhs-field">
          <label>Качество:</label>
          <select class="mhs-select" id="mhs-quality">
            <option value="webp" ${s.quality !== "original" ? "selected" : ""}>Сжатый (ридер)</option>
            <option value="original" ${s.quality === "original" ? "selected" : ""}>Оригинал (fullimg)</option>
          </select>
        </div>
        <div class="mhs-actions">
          <button class="mhs-btn mhs-btn-primary" id="mhs-btn-start">Скачать</button>
          <button class="mhs-btn mhs-btn-secondary" id="mhs-btn-pause" disabled>Пауза</button>
          <button class="mhs-btn mhs-btn-danger" id="mhs-btn-cancel" disabled>Отмена</button>
          <button class="mhs-btn mhs-btn-secondary" id="mhs-btn-openfolder" title="Открыть папку в Проводнике Windows (Shift + клик — открыть прямо внутри созданной подпапки манги)">📂 Открыть папку</button>
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

    updateFolderBtnLabel(savedHandle ? savedHandle.name : "");

    uiEls.pickDirBtn.addEventListener("click", async () => {
      try {
        const handle = await ensureBaseDirectoryHandle(true);
        state.rootDirHandle = handle;
        updateFolderBtnLabel(handle.name);
        syncUI(`Базовая папка выбрана: "${handle.name}". Внутри неё будет создана папка "${meta.title}".`);
      } catch {
        // Пользователь закрыл окно выбора папки
      }
    });

    uiEls.openFolderBtn.addEventListener("click", (e) => {
      handleOpenDownloadedFolder(Boolean(e.shiftKey));
    });

    uiEls.startBtn.addEventListener("click", async () => {
      const chosenMode = uiEls.modeSelect.value;
      let rootHandle = null;
      if (chosenMode === "folder") {
        try {
          rootHandle = await ensureBaseDirectoryHandle(false);
          state.rootDirHandle = rootHandle;
          updateFolderBtnLabel(rootHandle.name);
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
        rootHandle
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
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.action) return false;
    if (msg.action === "getPageStatus") {
      const meta = state.meta || detectPageMetadata();
      sendResponse({
        supported: true,
        running: state.running,
        paused: state.paused,
        current: state.current,
        total: state.total,
        statusText: state.statusText,
        lastSaveMode: state.lastSaveMode,
        meta
      });
      return true;
    }
    if (msg.action === "startFromPopup") {
      if (msg.options && uiEls) {
        if (msg.options.startPage) uiEls.startInput.value = msg.options.startPage;
        if (msg.options.endPage) uiEls.endInput.value = msg.options.endPage;
        if (msg.options.saveMode) uiEls.modeSelect.value = msg.options.saveMode;
        if (msg.options.quality) uiEls.qualitySelect.value = msg.options.quality;
      }
      startHarvest(msg.options || {});
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
    if (msg.action === "openFolderFromPopup") {
      handleOpenDownloadedFolder(false);
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  mountPanel();
})();
