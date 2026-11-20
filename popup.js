const els = {
  title: document.getElementById("gallery-title"),
  sub: document.getElementById("gallery-sub"),
  permBanner: document.getElementById("perm-banner"),
  startPage: document.getElementById("start-page"),
  endPage: document.getElementById("end-page"),
  saveMode: document.getElementById("save-mode"),
  folderTemplate: document.getElementById("folder-template"),
  quality: document.getElementById("quality"),
  fileTemplate: document.getElementById("file-template"),
  delayMs: document.getElementById("delay-ms"),
  maxRetries: document.getElementById("max-retries"),
  smartResume: document.getElementById("smart-resume"),
  includeComicInfo: document.getElementById("include-comicinfo"),
  progressFill: document.getElementById("progress-fill"),
  statusText: document.getElementById("status-text"),
  counterText: document.getElementById("counter-text"),
  btnStart: document.getElementById("btn-start"),
  btnPause: document.getElementById("btn-pause"),
  btnCancel: document.getElementById("btn-cancel"),
  btnOpenFolder: document.getElementById("btn-open-folder")
};

let activeTabId = null;
let initializedForGid = null;
let lastFolderPermState = "missing";

async function loadSettings() {
  const res = await chrome.storage.local.get(["harvesterSettings"]);
  const s = res.harvesterSettings || {};
  if (s.saveMode) els.saveMode.value = s.saveMode === "picker" ? "folder" : s.saveMode;
  if (s.folderTemplate) els.folderTemplate.value = s.folderTemplate;
  if (s.quality) els.quality.value = s.quality;
  if (s.fileTemplate) els.fileTemplate.value = s.fileTemplate;
  if (s.delayMs) els.delayMs.value = s.delayMs;
  if (s.maxRetries !== undefined) els.maxRetries.value = s.maxRetries;
  els.smartResume.checked = s.smartResume !== false;
  els.includeComicInfo.checked = s.includeComicInfo !== false;
}

async function saveSettings() {
  const existingRes = await chrome.storage.local.get(["harvesterSettings"]);
  const existing = existingRes?.harvesterSettings || {};
  const settings = {
    ...existing,
    saveMode: els.saveMode.value,
    folderTemplate: els.folderTemplate.value,
    quality: els.quality.value,
    fileTemplate: els.fileTemplate.value,
    delayMs: Math.max(1050, Number(els.delayMs.value || 1200)),
    maxRetries: Math.max(0, Number(els.maxRetries.value ?? 3)),
    smartResume: Boolean(els.smartResume.checked),
    includeComicInfo: Boolean(els.includeComicInfo.checked)
  };
  await chrome.storage.local.set({ harvesterSettings: settings });
  return settings;
}

for (const input of [
  els.saveMode,
  els.folderTemplate,
  els.quality,
  els.fileTemplate,
  els.delayMs,
  els.maxRetries,
  els.smartResume,
  els.includeComicInfo
]) {
  input.addEventListener("change", () => {
    saveSettings();
    updatePermissionBanner();
  });
}

function updatePermissionBanner() {
  const isFolderMode = els.saveMode.value === "folder";
  if (!isFolderMode || lastFolderPermState === "granted") {
    els.permBanner.classList.remove("visible");
    els.permBanner.textContent = "";
    return;
  }
  els.permBanner.classList.add("visible");
  if (lastFolderPermState === "prompt") {
    els.permBanner.textContent =
      "Для записи в папку после перезапуска браузера нажмите кнопку «🔓 Подтвердить папку» или «Скачать» прямо на панели страницы (1 клик).";
  } else {
    els.permBanner.textContent =
      "Базовая папка ещё не выбрана: нажмите «📁 Выбрать базовую папку» на панели страницы 1 раз.";
  }
}

async function pollTabStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  activeTabId = tab.id;

  chrome.tabs.sendMessage(activeTabId, { action: "getPageStatus" }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.supported) {
      els.btnStart.disabled = true;
      els.btnPause.disabled = true;
      els.btnCancel.disabled = true;
      return;
    }

    const meta = resp.meta;
    lastFolderPermState = resp.folderPermission || "missing";
    updatePermissionBanner();

    els.title.textContent = meta.title;
    const folderInfo = resp.folderName ? ` • 📁 ${resp.folderName}` : "";
    const existingInfo =
      resp.existingStatus === "complete_folder" ||
      resp.existingStatus === "complete_archive" ||
      resp.existingStatus === "complete_cached"
        ? " • ✅ Уже в папке"
        : resp.existingStatus === "partial_folder"
          ? ` • ⚠️ В папке ${resp.existingCount}/${meta.totalPages}`
          : "";
    els.sub.textContent = `GID: ${meta.gid} • ${meta.totalPages} стр.${folderInfo}${existingInfo}`;

    if (initializedForGid !== meta.gid) {
      els.startPage.max = meta.totalPages;
      els.endPage.max = meta.totalPages;
      els.startPage.value = meta.startPage || 1;
      els.endPage.value = meta.totalPages;
      initializedForGid = meta.gid;
    }

    const pct = resp.total > 0 ? Math.round((resp.current / resp.total) * 100) : 0;
    els.progressFill.style.width = `${pct}%`;
    els.statusText.textContent = resp.statusText || "Готов к работе";
    els.counterText.textContent = resp.total > 0 ? `${resp.current}/${resp.total}` : "";

    els.btnStart.disabled = resp.running;
    if (!resp.running) {
      if (
        resp.existingStatus === "complete_folder" ||
        resp.existingStatus === "complete_archive" ||
        resp.existingStatus === "complete_cached"
      ) {
        els.btnStart.textContent = "✅ Уже скачано";
      } else if (resp.existingStatus === "partial_folder") {
        els.btnStart.textContent = "▶ Докачать";
      } else {
        els.btnStart.textContent = "Скачать";
      }
    }
    els.btnPause.disabled = !resp.running;
    els.btnPause.textContent = resp.paused ? "Продолжить" : "Пауза";
    els.btnCancel.disabled = !resp.running;
  });
}

els.btnStart.addEventListener("click", async (e) => {
  if (!activeTabId) return;
  const settings = await saveSettings();

  if (settings.saveMode === "folder" && lastFolderPermState !== "granted") {
    chrome.tabs.sendMessage(activeTabId, { action: "focusPickDirFromPopup" }, () => {
      window.close();
    });
    return;
  }

  chrome.tabs.sendMessage(activeTabId, {
    action: "startFromPopup",
    forceRedownload: Boolean(e.shiftKey),
    options: {
      ...settings,
      startPage: Number(els.startPage.value || 1),
      endPage: Number(els.endPage.value || 1)
    }
  });
  setTimeout(pollTabStatus, 150);
});

els.btnPause.addEventListener("click", () => {
  if (!activeTabId) return;
  chrome.tabs.sendMessage(activeTabId, { action: "togglePauseFromPopup" }, () => pollTabStatus());
});

els.btnCancel.addEventListener("click", () => {
  if (!activeTabId) return;
  chrome.tabs.sendMessage(activeTabId, { action: "cancelFromPopup" }, () => pollTabStatus());
});

els.btnOpenFolder.addEventListener("click", () => {
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { action: "openFolderFromPopup" }, () => {
      window.close();
    });
  } else {
    chrome.runtime.sendMessage({
      action: "openDownloadsFolder",
      preferShowLastFile: els.saveMode.value === "cbz" || els.saveMode.value === "zip"
    });
  }
});

let pollTimer = null;
loadSettings().then(() => {
  pollTabStatus();
  pollTimer = setInterval(pollTabStatus, 800);
});

window.addEventListener("unload", () => {
  if (pollTimer) clearInterval(pollTimer);
});
