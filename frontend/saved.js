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
const imagePreviewList = document.querySelector("#imagePreviewList");
const imageCount = document.querySelector("#imageCount");
const generateImageButton = document.querySelector("#generateImageButton");
const deleteImageButton = document.querySelector("#deleteImageButton");
const sourceLabel = document.querySelector("#sourceLabel");
const debugPanel = document.querySelector("#debugPanel");
const debugSource = document.querySelector("#debugSource");
const debugText = document.querySelector("#debugText");

let savedItems = [];
let activeSubtest = "all";
let activePreviewRunId = "";
let activePreviewStatus = "";
let activePreviewSource = "";
let subtests = [];

function slugifySubtest(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function subtestFromPath() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] !== "saved" || !parts[1]) return "all";
  const slug = parts[1];
  const match = subtests.find((name) => slugifySubtest(name) === slug);
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

function setPreviewStatus(status) {
  activePreviewStatus = status || "";
  const source = activePreviewSource || "-";
  sourceLabel.textContent = activePreviewStatus
    ? `${source} / ${statusLabel(activePreviewStatus)}`
    : source;
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

function renderImages(data) {
  const images = data.web_files?.images || [];
  imageCount.textContent = `${images.length} page`;
  imagePreviewList.innerHTML = "";
  if (images.length === 0) {
    const empty = document.createElement("p");
    empty.className = "body-copy";
    empty.textContent = "Gambar 1000x1000 akan muncul di sini.";
    imagePreviewList.append(empty);
    return;
  }
  images.forEach((src, index) => {
    const link = document.createElement("a");
    link.href = src;
    link.target = "_blank";
    link.rel = "noopener";
    const image = document.createElement("img");
    image.className = "post-preview";
    image.src = `${src}?t=${Date.now()}`;
    image.alt = `Preview gambar saved ${index + 1}`;
    link.append(image);
    imagePreviewList.append(link);
  });
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
  const tabs = [{label: "Semua", value: "all", href: "/saved"}, ...subtests.map((name) => ({
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

async function loadConfig() {
  const response = await fetch("/config", {
    headers: {"Accept": "application/json"},
  });
  const config = await response.json();
  if (!response.ok) throw new Error(config.error || "Gagal memuat config.");
  subtests = Object.keys(config.topics || {});
  activeSubtest = subtestFromPath();
  renderSubtestTabs();
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
  items.forEach((item, index) => {
    const row = document.createElement("article");
    row.className = "saved-item";
    row.dataset.status = item.status || "saved";
    row.style.setProperty("--item-index", String(index));
    row.innerHTML = `
      <div>
        <strong></strong>
        <p></p>
      </div>
      <span></span>
      <div class="saved-actions">
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
    row.querySelector("[data-action='approved']").disabled = item.status === "approved";
    row.querySelector("[data-action='rejected']").disabled = item.status === "rejected";
    row.addEventListener("click", () => loadSavedPreview(item.run_id));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      loadSavedPreview(item.run_id);
    });
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
  });
}

async function loadSavedList() {
  const response = await fetch("/saved", {
    headers: {"Accept": "application/json"},
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Gagal memuat saved.");
  savedItems = data.items || [];
  renderSavedList();
}

async function loadSavedPreview(runId) {
  setStatus("Loading");
  activePreviewRunId = runId;
  const previewPanel = document.querySelector(".saved-preview");
  previewPanel?.classList.remove("is-loaded");
  previewPanel?.classList.add("is-loading");
  const response = await fetch(`/saved/${runId}`, {
    headers: {"Accept": "application/json"},
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus("Error");
    previewPanel?.classList.remove("is-loading");
    debugPanel.hidden = false;
    debugSource.textContent = "saved/preview";
    debugText.textContent = data.error || "Gagal membuka preview saved.";
    return;
  }
  const question = data.question;
  const caption = data.caption;
  const validation = data.validation;
  previewTitle.textContent = `${question.mapel}: ${question.topik}`;
  activePreviewSource = sourceText(data);
  setPreviewStatus(savedItems.find((item) => item.run_id === runId)?.status || "saved");
  validationScore.textContent = `Skor ${validation.skor ?? "-"}`;
  runNote.textContent = reviewNote(data);
  renderImages(data);
  generateImageButton.disabled = false;
  deleteImageButton.disabled = !(data.web_files?.images || []).length;
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
  previewPanel?.classList.remove("is-loading");
  requestAnimationFrame(() => previewPanel?.classList.add("is-loaded"));
}

function clearPreviewIfDeleted(runId) {
  if (activePreviewRunId !== runId) return;
  activePreviewRunId = "";
  activePreviewStatus = "";
  activePreviewSource = "";
  previewTitle.textContent = "Pilih item saved";
  runNote.textContent = "Preview saved akan muncul di sini.";
  questionText.textContent = "Pilih item saved untuk melihat soal.";
  choicesList.innerHTML = "";
  captionText.textContent = "Caption akan muncul di sini.";
  hashtagText.textContent = "";
  validationScore.textContent = "Skor belum tersedia";
  sourceLabel.textContent = "-";
  imageCount.textContent = "0 page";
  imagePreviewList.innerHTML = '<p class="body-copy">Gambar 1000x1000 akan muncul di sini.</p>';
  generateImageButton.disabled = true;
  deleteImageButton.disabled = true;
  metadataLink.hidden = true;
  metadataLink.href = "#";
  copyCaptionButton.disabled = true;
  debugPanel.hidden = true;
}

async function updateSavedStatus(runId, status) {
  setStatus("Updating");
  const response = await fetch(`/saved/${runId}/status`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({status}),
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
  if (activePreviewRunId === runId) {
    setPreviewStatus(status);
    runNote.textContent = `Status review sekarang ${statusLabel(status)}.`;
  }
}

async function deleteSavedRun(runId) {
  const item = savedItems.find((entry) => entry.run_id === runId);
  const label = item?.mapel ? `${item.mapel}: ${item.topik}` : runId;
  const ok = window.confirm(`Hapus soal saved ini?\n\n${label}\n${runId}\n\nFile preview dan metadata di folder saved juga akan dihapus.`);
  if (!ok) return;

  setStatus("Deleting");
  const response = await fetch(`/saved/${runId}`, {
    method: "DELETE",
    headers: {"Content-Type": "application/json"},
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

async function generateSavedImages() {
  if (!activePreviewRunId) return;
  generateImageButton.disabled = true;
  generateImageButton.textContent = "Generating";
  setStatus("Rendering");
  try {
    const response = await fetch(`/saved/${activePreviewRunId}/images`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Generate gambar gagal.");
    renderImages(data);
    deleteImageButton.disabled = !(data.web_files?.images || []).length;
    setStatus("Rendered");
    await loadSavedList();
  } catch (error) {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "saved/images";
    debugText.textContent = error.stack || error.message;
  } finally {
    generateImageButton.disabled = false;
    generateImageButton.textContent = "Generate";
  }
}

async function deleteSavedImages() {
  if (!activePreviewRunId) return;
  deleteImageButton.disabled = true;
  deleteImageButton.textContent = "Menghapus";
  setStatus("Deleting");
  try {
    const response = await fetch(`/saved/${activePreviewRunId}/images`, {
      method: "DELETE",
      headers: {"Content-Type": "application/json"},
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Hapus gambar gagal.");
    renderImages(data);
    deleteImageButton.disabled = true;
    setStatus("Deleted");
    await loadSavedList();
  } catch (error) {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "saved/images";
    debugText.textContent = error.stack || error.message;
  } finally {
    deleteImageButton.textContent = "Hapus gambar";
    generateImageButton.disabled = false;
  }
}

refreshSavedButton.addEventListener("click", () => {
  loadSavedList().catch((error) => {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "saved";
    debugText.textContent = error.stack || error.message;
  });
});

generateImageButton.addEventListener("click", generateSavedImages);
deleteImageButton.addEventListener("click", deleteSavedImages);

savedSearch.addEventListener("input", () => renderSavedList());
savedStatusFilter.addEventListener("change", () => renderSavedList());

exportApprovedButton.addEventListener("click", async () => {
  exportApprovedButton.disabled = true;
  exportApprovedButton.textContent = "Exporting";
  try {
    const response = await fetch("/export", {method: "POST"});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Export gagal.");
    setStatus("Exported");
    debugPanel.hidden = false;
    debugSource.textContent = "export";
    debugText.textContent = `Export selesai: ${data.total} item.\n\n${JSON.stringify(data, null, 2)}`;
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

async function init() {
  await loadConfig();
  await loadSavedList();
}

window.addEventListener("popstate", () => {
  activeSubtest = subtestFromPath();
  renderSubtestTabs();
  renderSavedList();
});

init().catch((error) => {
  setStatus("Error");
  debugPanel.hidden = false;
  debugSource.textContent = "saved";
  debugText.textContent = error.stack || error.message;
});
