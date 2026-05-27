const form = document.querySelector("#generateForm");
const mapelSelect = document.querySelector("#mapel");
const topicSelect = document.querySelector("#topik");
const button = document.querySelector("#generateButton");
const sourceStatus = document.querySelector("#sourceStatus");
const sourceLabel = document.querySelector("#sourceLabel");
const previewTitle = document.querySelector("#previewTitle");
const questionImage = document.querySelector("#questionImage");
const solutionImage = document.querySelector("#solutionImage");
const questionText = document.querySelector("#questionText");
const choicesList = document.querySelector("#choicesList");
const captionText = document.querySelector("#captionText");
const hashtagText = document.querySelector("#hashtagText");
const validationScore = document.querySelector("#validationScore");
const metadataLink = document.querySelector("#metadataLink");
const saveButton = document.querySelector("#saveButton");
const runNote = document.querySelector("#runNote");
const debugPanel = document.querySelector("#debugPanel");
const debugSource = document.querySelector("#debugSource");
const debugText = document.querySelector("#debugText");
const refreshSavedButton = document.querySelector("#refreshSavedButton");
const savedList = document.querySelector("#savedList");

let topicsByMapel = {};
let currentRunId = "";

function setStatus(text) {
  sourceStatus.textContent = text;
  sourceStatus.dataset.state = text.toLowerCase().replace(/\s+/g, "-");
}

function sourceText(data) {
  if (data.source === "gemini" && (!data.fallbacks || data.fallbacks.length === 0)) {
    return "Gemini penuh";
  }
  if (data.source === "fallback") {
    return "Fallback lokal";
  }
  if (data.fallbacks && data.fallbacks.length > 0) {
    return `Gemini + fallback ${data.fallbacks.join(", ")}`;
  }
  return data.source || "Draft lokal";
}

function reviewNote(data) {
  if (data.review_status === "ready") {
    return "Konten dari Gemini berhasil dibuat. Tetap lakukan review manual sebelum upload.";
  }
  if (data.errors && data.errors.question) {
    return `Mode fallback aktif: ${data.errors.question}`;
  }
  if (data.fallbacks && data.fallbacks.length > 0) {
    return `Fallback aktif untuk: ${data.fallbacks.join(", ")}. Review manual disarankan.`;
  }
  return "Review manual sebelum upload.";
}

function renderDebug(data) {
  const errors = data.errors || {};
  const fallbacks = data.fallbacks || [];
  const hasDebug = Object.keys(errors).length > 0 || fallbacks.length > 0 || data.source === "fallback";
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
    model: data.model,
  }, null, 2);
}

function fillTopics() {
  const topics = topicsByMapel[mapelSelect.value] || [];
  topicSelect.innerHTML = "";
  for (const topic of topics) {
    const option = document.createElement("option");
    option.value = topic;
    option.textContent = topic;
    topicSelect.append(option);
  }
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();
  topicsByMapel = config.topics;
  mapelSelect.innerHTML = "";
  for (const mapel of Object.keys(topicsByMapel)) {
    const option = document.createElement("option");
    option.value = mapel;
    option.textContent = mapel;
    mapelSelect.append(option);
  }
  fillTopics();
}

function renderResult(data) {
  currentRunId = data.run_id;
  const question = data.question;
  const caption = data.caption;
  const validation = data.validation;
  previewTitle.textContent = `${question.mapel}: ${question.topik}`;
  sourceLabel.textContent = sourceText(data);
  validationScore.textContent = `Skor ${validation.skor ?? "-"}`;
  runNote.textContent = reviewNote(data);
  renderDebug(data);
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
  questionImage.src = `${data.web_files.post_soal}?v=${Date.now()}`;
  solutionImage.src = `${data.web_files.post_pembahasan}?v=${Date.now()}`;
  metadataLink.href = data.web_files.metadata;
  metadataLink.hidden = false;
  saveButton.disabled = false;
  saveButton.textContent = "Simpan";
}

function statusLabel(status) {
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  return "Saved";
}

function renderSavedList(items) {
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
        <a target="_blank" rel="noreferrer">Buka</a>
        <button type="button" data-action="approved">Approve</button>
        <button type="button" data-action="rejected">Reject</button>
      </div>
    `;
    row.querySelector("strong").textContent = item.mapel ? `${item.mapel}: ${item.topik}` : item.run_id;
    row.querySelector("p").textContent = `${item.run_id} / ${item.source || "-"} / ${item.level || "-"}`;
    row.querySelector("span").textContent = statusLabel(item.status);
    row.querySelector("a").href = item.web_files.metadata;
    row.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => updateSavedStatus(item.run_id, button.dataset.action));
    });
    savedList.append(row);
  }
}

async function loadSavedList() {
  const response = await fetch("/api/saved");
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Gagal memuat saved.");
  }
  renderSavedList(data.items || []);
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

mapelSelect.addEventListener("change", fillTopics);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  setStatus("Generating");

  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Generate gagal.");
    }
    renderResult(data);
    setStatus(data.source === "gemini" ? "Gemini" : data.source === "fallback" ? "Fallback" : "Draft");
  } catch (error) {
    setStatus("Error");
    captionText.textContent = error.message;
    debugPanel.hidden = false;
    debugSource.textContent = "request";
    debugText.textContent = error.stack || error.message;
  } finally {
    button.disabled = false;
  }
});

saveButton.addEventListener("click", async () => {
  if (!currentRunId) return;
  saveButton.disabled = true;
  saveButton.textContent = "Menyimpan";
  try {
    const response = await fetch("/api/save", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({run_id: currentRunId}),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Simpan gagal.");
    }
    saveButton.textContent = "Tersimpan";
    setStatus("Saved");
    metadataLink.href = data.web_files.metadata;
    await loadSavedList();
  } catch (error) {
    saveButton.disabled = false;
    saveButton.textContent = "Simpan";
    setStatus("Error");
    captionText.textContent = error.message;
    debugPanel.hidden = false;
    debugSource.textContent = "save";
    debugText.textContent = error.stack || error.message;
  }
});

refreshSavedButton.addEventListener("click", () => {
  loadSavedList().catch((error) => {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "saved";
    debugText.textContent = error.stack || error.message;
  });
});

loadConfig().catch((error) => {
  setStatus("Error");
  captionText.textContent = error.message;
  debugPanel.hidden = false;
  debugSource.textContent = "config";
  debugText.textContent = error.stack || error.message;
});

loadSavedList().catch(() => {});
