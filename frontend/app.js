const form = document.querySelector("#generateForm");
const mapelSelect = document.querySelector("#mapel");
const topicSelect = document.querySelector("#topik");
const button = document.querySelector("#generateButton");
const sourceStatus = document.querySelector("#sourceStatus");
const sourceLabel = document.querySelector("#sourceLabel");
const previewTitle = document.querySelector("#previewTitle");
const questionText = document.querySelector("#questionText");
const choicesList = document.querySelector("#choicesList");
const captionText = document.querySelector("#captionText");
const hashtagText = document.querySelector("#hashtagText");
const validationScore = document.querySelector("#validationScore");
const metadataLink = document.querySelector("#metadataLink");
const downloadAllLink = document.querySelector("#downloadAllLink");
const imagePreviewList = document.querySelector("#imagePreviewList");
const imageCount = document.querySelector("#imageCount");
const saveButton = document.querySelector("#saveButton");
const runNote = document.querySelector("#runNote");
const debugPanel = document.querySelector("#debugPanel");
const debugSource = document.querySelector("#debugSource");
const debugText = document.querySelector("#debugText");
const copyCaptionButton = document.querySelector("#copyCaptionButton");

let topicsByMapel = {};
let currentRunId = "";
const {
  copyCaption,
  formatQuestionText,
  renderDebug: renderSharedDebug,
  renderImages: renderSharedImages,
  sourceText,
} = window.LatsoalShared;

function setStatus(text) {
  sourceStatus.textContent = text;
  sourceStatus.dataset.state = text.toLowerCase().replace(/\s+/g, "-");
}

function reviewNote(data) {
  if (data.dedup && data.dedup.is_duplicate) {
    return `Kemungkinan duplikat: similarity ${data.dedup.similarity} dengan ${data.dedup.matched_run_id}. Review sebelum dipakai.`;
  }
  if (data.review_status === "ready") {
    const provider = data.source === "kimi" ? "Kimi" : "Gemini";
    return `Konten dari ${provider} berhasil dibuat. Tetap lakukan review manual sebelum upload.`;
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
  renderSharedDebug(data, {debugPanel, debugSource, debugText});
}

function renderImages(data) {
  renderSharedImages(data, {imageCount, imagePreviewList});
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
  const response = await fetch("/config", {
    headers: {"Accept": "application/json"},
  });
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
  renderImages(data);
  questionText.textContent = formatQuestionText(question.soal);

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
  downloadAllLink.href = `/download/outputs/${data.run_id}`;
  downloadAllLink.hidden = false;
  saveButton.disabled = false;
  saveButton.textContent = "Simpan";
}

mapelSelect.addEventListener("change", fillTopics);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  setStatus("Generating");

  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    const response = await fetch("/generate", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Generate gagal.");
    }
    renderResult(data);
    setStatus(data.source === "gemini" ? "Gemini" : data.source === "kimi" ? "Kimi" : data.source === "fallback" ? "Fallback" : "Draft");
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
    const response = await fetch("/saved", {
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

copyCaptionButton.addEventListener("click", async () => {
  await copyCaption({captionText, hashtagText, debugPanel, debugSource, debugText}, setStatus);
});

loadConfig().catch((error) => {
  setStatus("Error");
  captionText.textContent = error.message;
  debugPanel.hidden = false;
  debugSource.textContent = "config";
  debugText.textContent = error.stack || error.message;
});
