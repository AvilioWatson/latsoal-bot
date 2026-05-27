const sourceStatus = document.querySelector("#sourceStatus");
const savedList = document.querySelector("#savedList");
const savedSearch = document.querySelector("#savedSearch");
const savedStatusFilter = document.querySelector("#savedStatusFilter");
const refreshSavedButton = document.querySelector("#refreshSavedButton");
const exportApprovedButton = document.querySelector("#exportApprovedButton");
const copyCaptionButton = document.querySelector("#copyCaptionButton");
const previewTitle = document.querySelector("#previewTitle");
const runNote = document.querySelector("#runNote");
const questionImage = document.querySelector("#questionImage");
const solutionImage = document.querySelector("#solutionImage");
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
    const haystack = [item.run_id, item.mapel, item.topik, item.level, item.source, item.status].join(" ").toLowerCase();
    return statusOk && (!query || haystack.includes(query));
  });
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
        <button type="button" data-open="preview">Preview</button>
        <a target="_blank" rel="noreferrer">JSON</a>
        <button type="button" data-action="approved">Approve</button>
        <button type="button" data-action="rejected">Reject</button>
      </div>
    `;
    row.querySelector("strong").textContent = item.mapel ? `${item.mapel}: ${item.topik}` : item.run_id;
    row.querySelector("p").textContent = `${item.run_id} / ${item.source || "-"} / ${item.level || "-"}`;
    row.querySelector("span").textContent = statusLabel(item.status);
    row.querySelector("a").href = item.web_files.metadata;
    row.querySelector("[data-open='preview']").addEventListener("click", () => loadSavedPreview(item.run_id));
    row.querySelectorAll("button").forEach((button) => {
      if (button.dataset.action) button.addEventListener("click", () => updateSavedStatus(item.run_id, button.dataset.action));
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
  questionImage.src = `${data.web_files.post_soal}?v=${Date.now()}`;
  solutionImage.src = `${data.web_files.post_pembahasan}?v=${Date.now()}`;
  metadataLink.href = data.web_files.metadata;
  metadataLink.hidden = false;
  renderDebug(data);
  setStatus(data.source === "gemini" ? "Gemini" : data.source === "fallback" ? "Fallback" : "Draft");
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
