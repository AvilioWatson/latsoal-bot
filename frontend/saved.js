const sourceStatus = document.querySelector("#sourceStatus");
const savedList = document.querySelector("#savedList");
const savedSearch = document.querySelector("#savedSearch");
const savedStatusFilter = document.querySelector("#savedStatusFilter");
const refreshSavedButton = document.querySelector("#refreshSavedButton");
const exportApprovedButton = document.querySelector("#exportApprovedButton");
const subtestTabs = document.querySelector("#subtestTabs");
const copyCaptionButton = document.querySelector("#copyCaptionButton");
const previewTitle = document.querySelector("#previewTitle");
const runNote = document.querySelector("#runNote");
const questionText = document.querySelector("#questionText");
const choicesList = document.querySelector("#choicesList");
const captionText = document.querySelector("#captionText");
const hashtagText = document.querySelector("#hashtagText");
const validationScore = document.querySelector("#validationScore");
const metadataLink = document.querySelector("#metadataLink");
const sourceLabel = document.querySelector("#sourceLabel");
const debugPanel = document.querySelector("#debugPanel");
const debugSource = document.querySelector("#debugSource");
const debugText = document.querySelector("#debugText");

let savedItems = [];
let activeSubtest = "all";
let activePreviewRunId = "";

const SUBTESTS = [
  "Penalaran Umum",
  "Pengetahuan dan Pemahaman Umum",
  "Pemahaman Bacaan dan Menulis",
  "Pengetahuan Kuantitatif",
  "Literasi Bahasa Indonesia",
  "Literasi Bahasa Inggris",
  "Penalaran Matematika",
];

function slugifySubtest(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function subtestFromPath() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] !== "saved" || !parts[1]) return "all";
  const slug = parts[1];
  const match = SUBTESTS.find((name) => slugifySubtest(name) === slug);
  return match || "all";
}

function setStatus(text) {
  sourceStatus.textContent = text;
  sourceStatus.dataset.state = text.toLowerCase().replace(/\s+/g, "-");
}

function sourceText(data) {
  if (data.source === "gemini" && (!data.fallbacks || data.fallbacks.length === 0)) return "Gemini penuh";
  if (data.source === "fallback") return "Fallback lokal";
  if (data.fallbacks && data.fallbacks.length > 0) return `Gemini + fallback ${data.fallbacks.join(", ")}`;
  return data.source || "Draft lokal";
}

function statusLabel(status) {
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  return "Saved";
}

function reviewNote(data) {
  if (data.dedup && data.dedup.is_duplicate) return `Kemungkinan duplikat: similarity ${data.dedup.similarity} dengan ${data.dedup.matched_run_id}.`;
  if (data.review_status === "ready") return "Konten siap direview final sebelum posting.";
  if (data.errors && data.errors.question) return `Mode fallback aktif: ${data.errors.question}`;
  return "Review manual sebelum upload.";
}

function renderDebug(data) {
  const errors = data.errors || {};
  const fallbacks = data.fallbacks || [];
  const hasDuplicate = data.dedup && data.dedup.is_duplicate;
  const hasDebug = Object.keys(errors).length > 0 || fallbacks.length > 0 || data.source === "fallback" || hasDuplicate;
  debugPanel.hidden = !hasDebug;
  if (!hasDebug) {
    debugText.textContent = "";
    debugSource.textContent = "Tidak ada";
    return;
  }
  debugSource.textContent = data.source || "unknown";
  debugText.textContent = JSON.stringify({
    source: data.source,
    review_status: data.review_status,
    fallbacks,
    errors,
    dedup: data.dedup,
    ai_usage: data.ai_usage,
    model: data.model,
  }, null, 2);
}

function filteredSavedItems() {
  const query = savedSearch.value.trim().toLowerCase();
  const status = savedStatusFilter.value;
  return savedItems.filter((item) => {
    const statusOk = status === "all" || (item.status || "saved") === status;
    const subtestOk = activeSubtest === "all" || item.mapel === activeSubtest;
    const haystack = [item.run_id, item.mapel, item.topik, item.level, item.source, item.status].join(" ").toLowerCase();
    return subtestOk && statusOk && (!query || haystack.includes(query));
  });
}

function renderSubtestTabs() {
  subtestTabs.innerHTML = "";
  const tabs = [{label: "Semua", value: "all", href: "/saved"}, ...SUBTESTS.map((name) => ({
    label: name,
    value: name,
    href: `/saved/${slugifySubtest(name)}`,
  }))];
  for (const tab of tabs) {
    const link = document.createElement("a");
    link.href = tab.href;
    link.textContent = tab.label;
    link.dataset.active = tab.value === activeSubtest ? "true" : "false";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      activeSubtest = tab.value;
      window.history.pushState({}, "", tab.href);
      renderSubtestTabs();
      renderSavedList();
    });
    subtestTabs.append(link);
  }
}

function renderSavedList(items = filteredSavedItems()) {
  savedList.innerHTML = "";
  if (!items || items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-copy";
    empty.textContent = "Belum ada soal disimpan.";
    savedList.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("article");
    row.className = "saved-item";
    row.dataset.status = item.status || "saved";
    row.innerHTML = `
      <div>
        <strong></strong>
        <p></p>
      </div>
      <span></span>
      <div class="saved-actions">
        <a target="_blank" rel="noreferrer">JSON</a>
        <button type="button" data-action="approved">Approve</button>
        <button type="button" data-action="rejected">Reject</button>
        <button type="button" data-delete="true">Hapus</button>
      </div>
    `;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Preview ${item.mapel || item.run_id}`);
    row.querySelector("strong").textContent = item.mapel ? `${item.mapel}: ${item.topik}` : item.run_id;
    row.querySelector("p").textContent = `${item.run_id} / ${item.source || "-"} / ${item.level || "-"}`;
    row.querySelector("span").textContent = statusLabel(item.status);
    row.querySelector("a").href = item.web_files.metadata;
    row.addEventListener("click", () => loadSavedPreview(item.run_id));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      loadSavedPreview(item.run_id);
    });
    row.querySelector("a").addEventListener("click", (event) => event.stopPropagation());
    row.querySelector("[data-delete='true']").addEventListener("click", (event) => {
      event.stopPropagation();
      deleteSavedRun(item.run_id);
    });
    row.querySelectorAll("button").forEach((button) => {
      if (button.dataset.action) {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          updateSavedStatus(item.run_id, button.dataset.action);
        });
      }
    });
    savedList.append(row);
  }
}

async function loadSavedList() {
  const response = await fetch("/api/saved");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Gagal memuat saved.");
  savedItems = data.items || [];
  renderSavedList();
}

async function loadSavedPreview(runId) {
  setStatus("Loading");
  activePreviewRunId = runId;
  const response = await fetch(`/api/saved/${runId}`);
  const data = await response.json();
  if (!response.ok) {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "saved/preview";
    debugText.textContent = data.error || "Gagal membuka preview saved.";
    return;
  }
  const question = data.question;
  const caption = data.caption;
  const validation = data.validation;
  previewTitle.textContent = `${question.mapel}: ${question.topik}`;
  sourceLabel.textContent = sourceText(data);
  validationScore.textContent = `Skor ${validation.skor ?? "-"}`;
  runNote.textContent = reviewNote(data);
  questionText.textContent = question.soal;
  choicesList.innerHTML = "";
  for (const [key, value] of Object.entries(question.pilihan)) {
    const item = document.createElement("li");
    item.innerHTML = `<strong>${key}</strong><span></span>`;
    item.querySelector("span").textContent = value;
    choicesList.append(item);
  }
  captionText.textContent = caption.caption || "";
  hashtagText.textContent = (caption.hashtag || []).join(" ");
  copyCaptionButton.disabled = false;
  metadataLink.href = data.web_files.metadata;
  metadataLink.hidden = false;
  renderDebug(data);
  setStatus(data.source === "gemini" ? "Gemini" : data.source === "fallback" ? "Fallback" : "Draft");
}

function clearPreviewIfDeleted(runId) {
  if (activePreviewRunId !== runId) return;
  activePreviewRunId = "";
  previewTitle.textContent = "Pilih item saved";
  runNote.textContent = "Preview saved akan muncul di sini.";
  questionText.textContent = "Pilih item saved untuk melihat soal.";
  choicesList.innerHTML = "";
  captionText.textContent = "Caption akan muncul di sini.";
  hashtagText.textContent = "";
  validationScore.textContent = "Skor belum tersedia";
  sourceLabel.textContent = "-";
  metadataLink.hidden = true;
  metadataLink.href = "#";
  copyCaptionButton.disabled = true;
  debugPanel.hidden = true;
}

async function updateSavedStatus(runId, status) {
  setStatus("Updating");
  const response = await fetch("/api/saved/status", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({run_id: runId, status}),
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "saved/status";
    debugText.textContent = data.error || "Update status gagal.";
    return;
  }
  setStatus(status === "approved" ? "Approved" : "Rejected");
  await loadSavedList();
}

async function deleteSavedRun(runId) {
  const item = savedItems.find((entry) => entry.run_id === runId);
  const label = item?.mapel ? `${item.mapel}: ${item.topik}` : runId;
  const ok = window.confirm(`Hapus soal saved ini?\n\n${label}\n${runId}\n\nFile preview dan metadata di folder saved juga akan dihapus.`);
  if (!ok) return;

  setStatus("Deleting");
  const response = await fetch("/api/saved/delete", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({run_id: runId}),
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "saved/delete";
    debugText.textContent = data.error || "Hapus soal gagal.";
    return;
  }

  setStatus("Deleted");
  clearPreviewIfDeleted(runId);
  await loadSavedList();
}

refreshSavedButton.addEventListener("click", () => {
  loadSavedList().catch((error) => {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "saved";
    debugText.textContent = error.stack || error.message;
  });
});

savedSearch.addEventListener("input", () => renderSavedList());
savedStatusFilter.addEventListener("change", () => renderSavedList());

exportApprovedButton.addEventListener("click", async () => {
  exportApprovedButton.disabled = true;
  exportApprovedButton.textContent = "Exporting";
  try {
    const response = await fetch("/api/export/approved", {method: "POST"});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Export gagal.");
    setStatus("Exported");
    debugPanel.hidden = false;
    debugSource.textContent = "export";
    debugText.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "export";
    debugText.textContent = error.stack || error.message;
  } finally {
    exportApprovedButton.disabled = false;
    exportApprovedButton.textContent = "Export approved";
  }
});

copyCaptionButton.addEventListener("click", async () => {
  const text = `${captionText.textContent}\n\n${hashtagText.textContent}`.trim();
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copied");
  } catch {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "clipboard";
    debugText.textContent = "Browser tidak mengizinkan clipboard. Salin caption secara manual.";
  }
});

loadSavedList().catch((error) => {
  setStatus("Error");
  debugPanel.hidden = false;
  debugSource.textContent = "saved";
  debugText.textContent = error.stack || error.message;
});

window.addEventListener("popstate", () => {
  activeSubtest = subtestFromPath();
  renderSubtestTabs();
  renderSavedList();
});

activeSubtest = subtestFromPath();
renderSubtestTabs();
