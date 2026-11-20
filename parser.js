(() => {
  // === ExManga Harvester Studio v2.0 — Парсер метаданных, пагинации и страниц ридера ===

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
      .replace(/\\/g, "/")
      .split("/")
      .filter((part) => part && part !== "." && part !== "..")
      .map((part) => sanitizeName(part, 95))
      .filter(Boolean)
      .join("/");
  }

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

  function detectPageMetadata(isGalleryPage) {
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

  const api = {
    sanitizeName,
    buildFolderPath,
    parseInlineScripts,
    parseGalleryTags,
    computeGalleryPagination,
    detectPageMetadata,
    decodeHtmlEntities,
    parseReaderFragments,
    parseFullReaderDocument,
    findReaderLinkInGalleryDoc,
    extractOriginalBaseName,
    formatEntryName
  };

  if (typeof globalThis !== "undefined") {
    globalThis.MHS_PARSER = api;
  }
})();
