const els = {
  title: document.getElementById("gallery-title"),
  sub: document.getElementById("gallery-sub"),
  startPage: document.getElementById("start-page"),
  endPage: document.getElementById("end-page"),
  saveMode: document.getElementById("save-mode"),
  folderTemplate: document.getElementById("folder-template"),
  quality: document.getElementById("quality"),
  fileTemplate: document.getElementById("file-template"),
  delayMs: document.getElementById("delay-ms"),
  maxRetries: document.getElementById("max-retries"),
  progressFill: document.getElementById("progress-fill"),
  statusText: document.getElementById("status-text"),
  counterText: document.getElementById("counter-text"),
  btnStart: document.getElementById("btn-start"),
  btnPause: document.getElementById("btn-pause"),
  btnCancel: document.getElementById("btn-cancel"),
  btnOpenFolder: document.getElementById("btn-open-folder")
};

let activeTabId = null;
let initializedRange = false;

async function loadSettings() {
  const res = await chrome.storage.local.get(["harvesterSettings"]);
  const s = res.harvesterSettings || {};
  if (s.saveMode) els.saveMode.value = s.saveMode === "picker" ? "folder" : s.saveMode;
  if (s.folderTemplate) els.folderTemplate.value = s.folderTemplate;
  if (s.quality) els.quality.value = s.quality;
  if (s.fileTemplate) els.fileTemplate.value = s.fileTemplate;
  if (s.delayMs) els.delayMs.value = s.delayMs;
  if (s.maxRetries !== undefined) els.maxRetries.value = s.maxRetries;
}

async function saveSettings() {
  const settings = {
    saveMode: els.saveMode.value,
    folderTemplate: els.folderTemplate.value,
    quality: els.quality.value,
    fileTemplate: els.fileTemplate.value,
    delayMs: Math.max(1050, Number(els.delayMs.value || 1200)),
    maxRetries: Math.max(0, Number(els.maxRetries.value ?? 3))
  };
  await chrome.storage.local.set({ harvesterSettings: settings });
  return settings;
}

for (const input of [els.saveMode, els.folderTemplate, els.quality, els.fileTemplate, els.delayMs, els.maxRetries]) {
  input.addEventListener("change", saveSettings);
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
    els.title.textContent = meta.title;
    els.sub.textContent = `GID: ${meta.gid} • Всего страниц: ${meta.totalPages}`;

    if (!initializedRange) {
      els.startPage.max = meta.totalPages;
      els.endPage.max = meta.totalPages;
      els.startPage.value = meta.startPage || 1;
      els.endPage.value = meta.totalPages;
      initializedRange = true;
    }

    const pct = resp.total > 0 ? Math.round((resp.current / resp.total) * 100) : 0;
    els.progressFill.style.width = `${pct}%`;
    els.statusText.textContent = resp.statusText || "Готов к работе";
    els.counterText.textContent = resp.total > 0 ? `${resp.current}/${resp.total}` : "";

    els.btnStart.disabled = resp.running;
    els.btnPause.disabled = !resp.running;
    els.btnPause.textContent = resp.paused ? "Продолжить" : "Пауза";
    els.btnCancel.disabled = !resp.running;
  });
}

els.btnStart.addEventListener("click", async () => {
  if (!activeTabId) return;
  const settings = await saveSettings();
  chrome.tabs.sendMessage(activeTabId, {
    action: "startFromPopup",
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
  chrome.runtime.sendMessage({
    action: "openDownloadsFolder",
    preferShowLastFile: els.saveMode.value === "cbz" || els.saveMode.value === "zip"
  });
});

loadSettings().then(() => {
  pollTabStatus();
  setInterval(pollTabStatus, 800);
});
