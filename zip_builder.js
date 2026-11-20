(() => {
  // === ExManga Harvester Studio v2.0 — Упаковщик PKZIP (STORE + CRC32 + UTF-8) и ComicInfo.xml ===
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

  function buildComicInfoXmlString(meta, syncToken = "") {
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

    const currentHref =
      typeof window !== "undefined" && window.location ? window.location.href : "";

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
      `  <Web>${escapeXml(meta.galleryUrl || currentHref)}</Web>`,
      `  <Notes>Downloaded with ExManga Harvester Studio v2.0 (GID: ${meta.gid})</Notes>`,
      "</ComicInfo>",
      syncToken ? `<!-- mhs-sync:${syncToken} -->` : null
    ].filter(Boolean);

    return lines.join("\n");
  }

  function buildComicInfoXml(meta, syncToken = "") {
    return new TextEncoder().encode(buildComicInfoXmlString(meta, syncToken));
  }

  const api = {
    crc32,
    buildZipBlob,
    escapeXml,
    buildComicInfoXmlString,
    buildComicInfoXml
  };

  if (typeof globalThis !== "undefined") {
    globalThis.MHS_ZIP = api;
  }
})();
