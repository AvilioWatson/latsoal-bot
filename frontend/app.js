const form = document.querySelector("#generateForm");
const mapelSelect = document.querySelector("#mapel");
const topicSelect = document.querySelector("#topik");
const newTopicInput = document.querySelector("#newTopicInput");
const addTopicButton = document.querySelector("#addTopicButton");
const addTopicNote = document.querySelector("#addTopicNote");
const deleteTopicButton = document.querySelector("#deleteTopicButton");
const deleteTopicNote = document.querySelector("#deleteTopicNote");
const button = document.querySelector("#generateButton");
const autoGenerateButton = document.querySelector("#autoGenerateButton");
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
const batchResults = document.querySelector("#batchResults");
const batchResultCount = document.querySelector("#batchResultCount");
const batchResultList = document.querySelector("#batchResultList");
const saveAllBatchButton = document.querySelector("#saveAllBatchButton");
const resetCacheButton = document.querySelector("#resetCacheButton");
const checkSimilarityButton = document.querySelector("#checkSimilarityButton");
const previewCompareLayout = document.querySelector("#previewCompareLayout");
const currentSimilarityChip = document.querySelector("#currentSimilarityChip");
const similarPreviewPanel = document.querySelector("#similarPreviewPanel");
const similarPreviewTitle = document.querySelector("#similarPreviewTitle");
const similarRunNote = document.querySelector("#similarRunNote");
const similarityMatchScore = document.querySelector("#similarityMatchScore");
const openSavedMatchLink = document.querySelector("#openSavedMatchLink");
const similarMetadataLink = document.querySelector("#similarMetadataLink");
const similarImagePreviewList = document.querySelector("#similarImagePreviewList");
const similarImageCount = document.querySelector("#similarImageCount");
const similarValidationScore = document.querySelector("#similarValidationScore");
const similarQuestionText = document.querySelector("#similarQuestionText");
const similarChoicesList = document.querySelector("#similarChoicesList");
const similarCaptionText = document.querySelector("#similarCaptionText");
const similarHashtagText = document.querySelector("#similarHashtagText");
const similarSourceLabel = document.querySelector("#similarSourceLabel");
const BATCH_STORAGE_KEY = "latsoal:auto-generator:latest";

let topicsByMapel = {};
let currentRunId = "";
let currentPreviewData = null;
let batchItems = [];
const {
  copyCaption: sharedCopyCaption = async (elements, setStatusCallback) => {
    const {captionText, hashtagText, debugPanel, debugSource, debugText} = elements;
    try {
      await navigator.clipboard.writeText(`${captionText.textContent}\n${hashtagText.textContent}`.trim());
      setStatusCallback("Copied");
    } catch (error) {
      debugPanel.hidden = false;
      debugSource.textContent = "clipboard";
      debugText.textContent = error.message;
    }
  },
  formatQuestionText: sharedFormatQuestionText = (text) => text || "",
  renderDebug: sharedRenderDebug = (data, elements) => {
    elements.debugText.textContent = JSON.stringify(data, null, 2);
    elements.debugPanel.hidden = false;
  },
  renderImages: sharedRenderImages = (data, elements) => {
    const images = data.web_files?.images || [];
    elements.imageCount.textContent = `${images.length} gambar`;
    elements.imagePreviewList.innerHTML = "";
    for (const image of images) {
      const img = document.createElement("img");
      img.src = image;
      img.alt = "Preview gambar";
      elements.imagePreviewList.append(img);
    }
  },
  sourceText: sharedSourceText = (data) => data.source || "-",
} = window.LatsoalShared || {};

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

function similarityText(data) {
  const similarity = Number(data?.dedup?.similarity);
  if (!Number.isFinite(similarity)) return "Similarity -";
  const percent = Math.round(similarity * 1000) / 10;
  const match = data?.dedup?.matched_run_id ? ` dengan ${data.dedup.matched_run_id}` : "";
  return `Similarity ${percent}%${match}`;
}

function similarityPercent(similarity) {
  const value = Number(similarity);
  if (!Number.isFinite(value)) return "-";
  return `${Math.round(value * 1000) / 10}%`;
}

function similarityBadgeState(dedup) {
  const similarity = Number(dedup?.similarity);
  if (!Number.isFinite(similarity)) return "pending";
  if (dedup?.is_duplicate) return "similar";
  return similarity > 0 ? "checked" : "clear";
}

function applySimilarityBadge(element, dedup, {includeMatch = false, prefix = "Similarity"} = {}) {
  if (!element) return;
  const similarity = Number(dedup?.similarity);
  if (!Number.isFinite(similarity)) {
    element.textContent = `${prefix} -`;
    element.dataset.state = "pending";
    return;
  }
  const match = includeMatch && dedup?.matched_run_id ? ` · ${dedup.matched_run_id}` : "";
  element.textContent = `${prefix} ${similarityPercent(similarity)}${match}`;
  element.dataset.state = similarityBadgeState(dedup);
}

function setImagePlaceholder(container, text) {
  container.innerHTML = "";
  const placeholder = document.createElement("p");
  placeholder.className = "body-copy";
  placeholder.textContent = text;
  container.append(placeholder);
}

function renderPreviewImages(data, elements, emptyText) {
  renderImages(data, elements);
  if (!Array.isArray(data?.web_files?.images) || data.web_files.images.length === 0) {
    setImagePlaceholder(elements.imagePreviewList, emptyText);
  }
}

function renderChoices(target, choices = {}) {
  target.innerHTML = "";
  for (const [key, value] of Object.entries(choices || {})) {
    const item = document.createElement("li");
    item.innerHTML = `<strong>${key}</strong><span></span>`;
    item.querySelector("span").textContent = value;
    target.append(item);
  }
}

function syncCurrentSimilarityUi(dedup) {
  if (!currentPreviewData) return;
  currentPreviewData = {...currentPreviewData, dedup};
  validationScore.textContent = `Skor ${currentPreviewData.validation?.skor ?? "-"} · ${similarityText(currentPreviewData)}`;
  runNote.textContent = reviewNote(currentPreviewData);
  applySimilarityBadge(currentSimilarityChip, dedup);
}

function clearSimilarPreview({hide = true, note} = {}) {
  if (!similarPreviewPanel) return;
  similarPreviewPanel.hidden = hide;
  previewCompareLayout.dataset.hasMatch = hide ? "false" : "true";
  similarPreviewTitle.textContent = hide ? "Belum dicek" : "Tidak ada soal mirip";
  similarRunNote.textContent = note || (hide
    ? "Klik Cek Similarity untuk melihat soal saved yang paling mirip."
    : "Belum ada soal saved yang melewati threshold similarity.");
  similarValidationScore.textContent = "Skor belum tersedia";
  similarQuestionText.textContent = hide ? "Belum ada soal pembanding." : "Tidak ada pembanding yang perlu direview.";
  similarChoicesList.innerHTML = "";
  similarCaptionText.textContent = "Caption soal pembanding akan muncul di sini.";
  similarHashtagText.textContent = "";
  similarSourceLabel.textContent = "Bank Review";
  similarImageCount.textContent = "0 page";
  setImagePlaceholder(similarImagePreviewList, hide
    ? "Preview soal pembanding akan muncul di sini."
    : "Tidak ada soal saved yang cukup mirip untuk ditampilkan.");
  applySimilarityBadge(similarityMatchScore, null);
  openSavedMatchLink.hidden = true;
  openSavedMatchLink.href = "#";
  similarMetadataLink.hidden = true;
  similarMetadataLink.href = "#";
}

function renderSimilarPreview(match, dedup) {
  const question = match.question || {};
  const caption = match.caption || {};
  similarPreviewPanel.hidden = false;
  previewCompareLayout.dataset.hasMatch = "true";
  similarPreviewTitle.textContent = `${question.mapel || "Tanpa subtes"}: ${question.topik || "Tanpa subtopik"}`;
  similarRunNote.textContent = `Run ${match.run_id || "-"} di Bank Review paling mirip dengan preview kanan.`;
  similarValidationScore.textContent = `Skor ${match.validation?.skor ?? "-"} · Similarity ${similarityPercent(dedup?.similarity)}`;
  similarSourceLabel.textContent = match.source === "import" ? "Import" : "Bank Review";
  similarQuestionText.textContent = sharedFormatQuestionText(question.soal || "");
  renderChoices(similarChoicesList, question.pilihan || {});
  similarCaptionText.textContent = caption.caption || "";
  similarHashtagText.textContent = Array.isArray(caption.hashtag) ? caption.hashtag.join(" ") : "";
  renderPreviewImages(match, {imageCount: similarImageCount, imagePreviewList: similarImagePreviewList}, "Preview soal pembanding belum memiliki gambar.");
  applySimilarityBadge(similarityMatchScore, dedup, {includeMatch: false});
  openSavedMatchLink.hidden = !match.run_id;
  openSavedMatchLink.href = match.run_id ? `/saved/${match.run_id}` : "#";
  similarMetadataLink.hidden = !match.web_files?.metadata;
  similarMetadataLink.href = match.web_files?.metadata || "#";
}

function renderDebug(data) {
  sharedRenderDebug(data, {debugPanel, debugSource, debugText});
}

function renderImages(data, elements = {imageCount, imagePreviewList}) {
  sharedRenderImages(data, elements);
}

function readStoredBatchState() {
  try {
    const raw = localStorage.getItem(BATCH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.results)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistBatchState(extra = {}) {
  try {
    if (!batchItems.length) return;
    localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify({
      saved_at: new Date().toISOString(),
      results: batchItems,
      current_run_id: currentRunId,
      ...extra,
    }));
  } catch {
    // Storage can be unavailable in private browsing. The in-memory list still works.
  }
}

function clearBatchState() {
  try {
    localStorage.removeItem(BATCH_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function hideBatchResults({clearStored = true} = {}) {
  batchItems = [];
  if (!batchResults || !batchResultList || !batchResultCount) return;
  batchResults.hidden = true;
  batchResultList.innerHTML = "";
  batchResultCount.textContent = "0 soal";
  if (clearStored) clearBatchState();
  if (saveAllBatchButton) {
    saveAllBatchButton.disabled = true;
    saveAllBatchButton.textContent = "Simpan semua soal";
  }
}

function clearPreviewDraft() {
  currentRunId = "";
  currentPreviewData = null;
  previewTitle.textContent = "Belum ada output";
  runNote.textContent = "Generate konten untuk mulai review.";
  sourceLabel.textContent = "Manual";
  validationScore.textContent = "Skor belum tersedia";
  questionText.textContent = "Generate konten untuk melihat soal.";
  choicesList.innerHTML = "";
  captionText.textContent = "Caption akan muncul di sini.";
  hashtagText.textContent = "";
  imageCount.textContent = "0 page";
  imagePreviewList.innerHTML = '<p class="body-copy">Gambar 1000x1000 akan muncul di sini.</p>';
  metadataLink.hidden = true;
  metadataLink.href = "#";
  downloadAllLink.hidden = true;
  downloadAllLink.href = "#";
  saveButton.disabled = true;
  saveButton.textContent = "Simpan";
  copyCaptionButton.disabled = true;
  checkSimilarityButton.disabled = true;
  applySimilarityBadge(currentSimilarityChip, null);
  clearSimilarPreview();
  debugPanel.hidden = true;
  debugSource.textContent = "Tidak ada";
  debugText.textContent = "";
}

function fillSubtests(selectedMapel = "") {
  const subtests = Object.keys(topicsByMapel);
  mapelSelect.innerHTML = "";
  for (const mapel of subtests) {
    const option = document.createElement("option");
    option.value = mapel;
    option.textContent = mapel;
    mapelSelect.append(option);
  }
  if (selectedMapel && subtests.includes(selectedMapel)) {
    mapelSelect.value = selectedMapel;
  }
  mapelSelect.disabled = subtests.length === 0;
  button.disabled = subtests.length === 0;
  if (autoGenerateButton) autoGenerateButton.disabled = subtests.length === 0;
  if (deleteTopicButton) deleteTopicButton.disabled = (topicsByMapel[mapelSelect.value] || []).length <= 1;
}

function fillTopics(selectedTopic = "") {
  const topics = topicsByMapel[mapelSelect.value] || [];
  topicSelect.innerHTML = "";
  for (const topic of topics) {
    const option = document.createElement("option");
    option.value = topic;
    option.textContent = topic;
    topicSelect.append(option);
  }
  if (selectedTopic && topics.includes(selectedTopic)) {
    topicSelect.value = selectedTopic;
  }
  if (deleteTopicButton) deleteTopicButton.disabled = topics.length <= 1;
}

async function loadConfig() {
  const response = await fetch("/config", {
    headers: {"Accept": "application/json"},
  });
  const config = await response.json();
  topicsByMapel = config.topics;
  fillSubtests();
  fillTopics();
}

async function addSelectedSubtopic() {
  const mapel = mapelSelect.value;
  const topik = (newTopicInput?.value || "").trim().replace(/\s+/g, " ");
  if (!topik) {
    addTopicNote.textContent = "Isi nama subtopik dulu.";
    return;
  }

  addTopicButton.disabled = true;
  addTopicNote.textContent = "Menyimpan subtopik...";
  try {
    const response = await fetch("/api/config/topics", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({mapel, topik}),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Gagal menambah subtopik.");
    }
    topicsByMapel = data.config?.topics || topicsByMapel;
    fillTopics(data.topik);
    newTopicInput.value = "";
    addTopicNote.textContent = data.created ? "Subtopik ditambahkan." : "Subtopik sudah ada.";
  } catch (error) {
    addTopicNote.textContent = error.message;
    debugPanel.hidden = false;
    debugSource.textContent = "config-topics";
    debugText.textContent = error.stack || error.message;
  } finally {
    addTopicButton.disabled = false;
  }
}

async function deleteSelectedTopic() {
  const mapel = mapelSelect.value;
  const topik = topicSelect.value;
  if (!mapel || !topik) return;
  const confirmed = window.confirm(`Hapus subtopik "${topik}" dari subtes "${mapel}"? Soal yang sudah tersimpan tidak dihapus, tetapi akan ditandai perlu ganti subtopik.`);
  if (!confirmed) return;

  deleteTopicButton.disabled = true;
  deleteTopicNote.textContent = "Menghapus subtopik...";
  try {
    const response = await fetch("/api/config/topics", {
      method: "DELETE",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({mapel, topik}),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Gagal menghapus subtopik.");
    }
    topicsByMapel = data.config?.topics || topicsByMapel;
    fillTopics();
    deleteTopicNote.textContent = `Subtopik "${data.topik}" dihapus.`;
  } catch (error) {
    deleteTopicNote.textContent = error.message;
    debugPanel.hidden = false;
    debugSource.textContent = "config-topics";
    debugText.textContent = error.stack || error.message;
  } finally {
    if (deleteTopicButton) deleteTopicButton.disabled = (topicsByMapel[mapelSelect.value] || []).length <= 1;
  }
}

function renderResult(data) {
  hideBatchResults();
  renderPreviewResult(data);
}

function renderPreviewResult(data) {
  currentPreviewData = data;
  currentRunId = data.run_id;
  const question = data.question;
  const caption = data.caption;
  const validation = data.validation;
  previewTitle.textContent = `${question.mapel}: ${question.topik}`;
  sourceLabel.textContent = sharedSourceText(data);
  validationScore.textContent = `Skor ${validation.skor ?? "-"} · ${similarityText(data)}`;
  runNote.textContent = reviewNote(data);
  renderDebug(data);
  renderPreviewImages(data, {imageCount, imagePreviewList}, "Gambar 1000x1000 akan muncul di sini.");
  questionText.textContent = sharedFormatQuestionText(question.soal);
  renderChoices(choicesList, question.pilihan);

  captionText.textContent = caption.caption || "";
  hashtagText.textContent = (caption.hashtag || []).join(" ");
  copyCaptionButton.disabled = false;
  metadataLink.href = data.web_files.metadata;
  metadataLink.hidden = false;
  downloadAllLink.href = `/download/outputs/${data.run_id}`;
  downloadAllLink.hidden = false;
  saveButton.disabled = false;
  saveButton.textContent = "Simpan";
  checkSimilarityButton.disabled = false;
  applySimilarityBadge(currentSimilarityChip, data.dedup);
  clearSimilarPreview();
}

function questionExcerpt(question) {
  return sharedFormatQuestionText(question?.soal || "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function selectedAutoCount() {
  return form.querySelector('input[name="auto_count"]:checked')?.value || "5";
}

function buildGeneratePayload() {
  const payload = Object.fromEntries(new FormData(form).entries());
  delete payload.auto_count;
  return payload;
}

function renderBatchResult(data) {
  const lastResult = data.last_result || data.results?.[data.results.length - 1];
  if (lastResult) {
    renderPreviewResult(lastResult);
  }

  const generated = Number(data.generated_count || 0);
  const requested = Number(data.requested_count || 0);
  const message = data.message || `Auto generator membuat ${generated} dari ${requested} soal.`;
  runNote.textContent = message;
  setStatus(generated === requested ? "Auto selesai" : "Auto partial");
  renderDebug({
    message,
    requested_count: requested,
    generated_count: generated,
    token_limited: Boolean(data.token_limited),
    generated_runs: (data.results || []).map((item) => ({
      run_id: item.run_id,
      mapel: item.question?.mapel,
      topik: item.question?.topik,
      metadata: item.web_files?.metadata,
    })),
    failures: data.failures || [],
  });

  if (!lastResult) {
    previewTitle.textContent = "Auto generator belum menghasilkan soal";
    captionText.textContent = message;
    saveButton.disabled = true;
  }

  renderBatchList(data.results || []);
  persistBatchState({
    message,
    requested_count: requested,
    generated_count: generated,
    token_limited: Boolean(data.token_limited),
    actual_token_usage: data.actual_token_usage || 0,
  });
}

function renderBatchList(results) {
  if (!batchResults || !batchResultList || !batchResultCount) return;
  batchItems = results;
  batchResultList.innerHTML = "";
  batchResults.hidden = results.length === 0;
  batchResultCount.textContent = `${results.length} soal`;
  if (saveAllBatchButton) {
    saveAllBatchButton.disabled = results.length === 0;
    saveAllBatchButton.textContent = "Simpan semua soal";
  }
  persistBatchState();

  results.forEach((item, index) => {
    const question = item.question || {};
    const article = document.createElement("article");
    article.className = "batch-result-item";
    article.dataset.runId = item.run_id || "";

    const header = document.createElement("div");
    header.className = "batch-result-header";

    const number = document.createElement("span");
    number.className = "batch-result-number";
    number.textContent = String(index + 1).padStart(2, "0");

    const title = document.createElement("div");
    title.className = "batch-result-title";
    const heading = document.createElement("h4");
    heading.textContent = `${question.mapel || "Tanpa subtes"}: ${question.topik || "Tanpa subtopik"}`;
    const meta = document.createElement("p");
    meta.textContent = `${item.run_id || "-"} · ${sharedSourceText(item)} · Skor ${item.validation?.skor ?? "-"} · ${similarityText(item)}`;
    title.append(heading, meta);

    header.append(number, title);

    const excerpt = document.createElement("p");
    excerpt.className = "batch-result-excerpt";
    excerpt.textContent = questionExcerpt(question) || "Soal belum memiliki ringkasan.";

    const actions = document.createElement("div");
    actions.className = "batch-result-actions";

    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.className = "mini-button";
    previewButton.textContent = "Preview";
    previewButton.addEventListener("click", () => {
      renderPreviewResult(item);
      document.querySelector(".review-header")?.scrollIntoView({behavior: "smooth", block: "start"});
    });
    actions.append(previewButton);

    const saveItemButton = document.createElement("button");
    saveItemButton.type = "button";
    saveItemButton.className = "mini-button";
    saveItemButton.textContent = "Simpan";
    saveItemButton.dataset.saveRunId = item.run_id || "";
    saveItemButton.addEventListener("click", () => saveRunFromBatch(item, saveItemButton));
    actions.append(saveItemButton);

    if (item.web_files?.metadata) {
      const metadata = document.createElement("a");
      metadata.className = "mini-link";
      metadata.href = item.web_files.metadata;
      metadata.textContent = "Metadata";
      actions.append(metadata);
    }

    if (item.run_id) {
      const download = document.createElement("a");
      download.className = "mini-link";
      download.href = `/download/outputs/${item.run_id}`;
      download.textContent = "ZIP";
      actions.append(download);
    }

    article.append(header, excerpt, actions);
    batchResultList.append(article);
  });
}

async function saveRunFromBatch(item, trigger) {
  if (!item?.run_id) return false;
  trigger.disabled = true;
  trigger.textContent = "Menyimpan";
  try {
    const response = await fetch("/saved", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({run_id: item.run_id}),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Simpan gagal.");
    }
    trigger.textContent = "Tersimpan";
    setStatus("Saved");
    item.saved_web_files = data.web_files;
    item.saved = true;
    syncSaveAllBatchButton();
    persistBatchState();
    return true;
  } catch (error) {
    trigger.disabled = false;
    trigger.textContent = "Simpan";
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "save-batch";
    debugText.textContent = error.stack || error.message;
    return false;
  }
}

function syncSaveAllBatchButton() {
  if (!saveAllBatchButton) return;
  const remaining = batchItems.filter((item) => item?.run_id && !item.saved).length;
  saveAllBatchButton.disabled = remaining === 0;
  saveAllBatchButton.textContent = remaining === 0 ? "Semua tersimpan" : `Simpan semua soal (${remaining})`;
}

async function saveAllBatchResults() {
  if (!batchItems.length || !saveAllBatchButton) return;
  saveAllBatchButton.disabled = true;
  let saved = 0;
  let failed = 0;

  for (const item of batchItems) {
    if (!item?.run_id || item.saved) continue;
    const trigger = batchResultList?.querySelector(`[data-save-run-id="${CSS.escape(item.run_id)}"]`);
    const ok = await saveRunFromBatch(item, trigger || saveAllBatchButton);
    if (ok) {
      saved += 1;
      saveAllBatchButton.textContent = `Menyimpan ${saved}/${batchItems.length}`;
    } else {
      failed += 1;
    }
  }

  const remaining = batchItems.filter((item) => item?.run_id && !item.saved).length;
  if (failed || remaining) {
    setStatus("Save partial");
    saveAllBatchButton.disabled = false;
    saveAllBatchButton.textContent = `Simpan sisa soal (${remaining})`;
    return;
  }

  setStatus("Saved all");
  syncSaveAllBatchButton();
  persistBatchState();
}

async function resetGeneratorCache() {
  const confirmed = window.confirm("Reset cache generator? Soal di Bank Review tidak dihapus. Output yang belum tersimpan akan dibersihkan.");
  if (!confirmed) return;
  resetCacheButton.disabled = true;
  resetCacheButton.textContent = "Resetting";
  setStatus("Reset cache");
  try {
    const response = await fetch("/api/generator/cache", {method: "DELETE"});
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Reset cache gagal.");
    }
    clearBatchState();
    hideBatchResults({clearStored: false});
    clearPreviewDraft();
    setStatus("Cache reset");
    runNote.textContent = `Cache dibersihkan: ${data.deleted_count || 0} output belum tersimpan dihapus. Draft ${data.unsaved_draft || 0}, fallback ${data.unsaved_fallback || 0}.`;
    renderDebug(data);
  } catch (error) {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "reset-cache";
    debugText.textContent = error.stack || error.message;
  } finally {
    resetCacheButton.disabled = false;
    resetCacheButton.textContent = "Reset cache";
  }
}

async function checkSimilarityForCurrentRun() {
  if (!currentRunId) return;
  checkSimilarityButton.disabled = true;
  checkSimilarityButton.textContent = "Mengecek...";
  setStatus("Checking similarity");
  clearSimilarPreview({
    hide: false,
    note: "Menghitung ulang similarity terhadap item di Bank Review.",
  });
  similarPreviewTitle.textContent = "Mencari soal paling mirip";

  try {
    const response = await fetch("/api/generate/similarity", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({run_id: currentRunId}),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Gagal menghitung ulang similarity.");
    }

    syncCurrentSimilarityUi(data.dedup);
    if (data.match) {
      renderSimilarPreview(data.match, data.dedup);
      setStatus("Similarity checked");
    } else {
      clearSimilarPreview({
        hide: false,
        note: `Similarity tertinggi ${similarityPercent(data.dedup?.similarity)} masih di bawah threshold ${similarityPercent(data.threshold)}.`,
      });
      applySimilarityBadge(similarityMatchScore, data.dedup);
      setStatus("Similarity clear");
    }
  } catch (error) {
    setStatus("Error");
    clearSimilarPreview({
      hide: false,
      note: error.message,
    });
    debugPanel.hidden = false;
    debugSource.textContent = "similarity";
    debugText.textContent = error.stack || error.message;
  } finally {
    checkSimilarityButton.disabled = !currentRunId;
    checkSimilarityButton.textContent = "Cek Similarity";
  }
}

function restoreBatchState() {
  const stored = readStoredBatchState();
  if (!stored?.results?.length) return;
  const lastResult = stored.results.find((item) => item?.run_id === stored.current_run_id)
    || stored.results[stored.results.length - 1];
  if (lastResult) {
    renderPreviewResult(lastResult);
  }
  renderBatchList(stored.results);
  const generated = Number(stored.generated_count || stored.results.length);
  const requested = Number(stored.requested_count || generated);
  runNote.textContent = stored.message || `Auto generator sebelumnya memuat ${generated} dari ${requested} soal.`;
  setStatus("Draft batch");
  syncSaveAllBatchButton();
}

mapelSelect.addEventListener("change", () => fillTopics());
addTopicButton?.addEventListener("click", addSelectedSubtopic);
deleteTopicButton?.addEventListener("click", deleteSelectedTopic);
newTopicInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addSelectedSubtopic();
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  if (autoGenerateButton) autoGenerateButton.disabled = true;
  setStatus("Generating");

  const payload = buildGeneratePayload();
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
    if (autoGenerateButton) autoGenerateButton.disabled = false;
  }
});

autoGenerateButton?.addEventListener("click", async () => {
  hideBatchResults();
  button.disabled = true;
  autoGenerateButton.disabled = true;
  autoGenerateButton.textContent = "Generating batch";
  setStatus("Auto batch");

  const payload = {
    ...buildGeneratePayload(),
    count: selectedAutoCount(),
  };
  delete payload.topik;

  try {
    const response = await fetch("/generate/auto", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || data.detail || "Auto generator gagal.");
    }
    renderBatchResult(data);
  } catch (error) {
    setStatus("Error");
    captionText.textContent = error.message;
    debugPanel.hidden = false;
    debugSource.textContent = "auto-generator";
    debugText.textContent = error.stack || error.message;
  } finally {
    button.disabled = false;
    autoGenerateButton.disabled = false;
    autoGenerateButton.textContent = "Auto Generator";
  }
});

saveAllBatchButton?.addEventListener("click", saveAllBatchResults);
resetCacheButton?.addEventListener("click", resetGeneratorCache);
checkSimilarityButton?.addEventListener("click", checkSimilarityForCurrentRun);

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
  await sharedCopyCaption({captionText, hashtagText, debugPanel, debugSource, debugText}, setStatus);
});

loadConfig().catch((error) => {
  setStatus("Error");
  captionText.textContent = error.message;
  debugPanel.hidden = false;
  debugSource.textContent = "config";
  debugText.textContent = error.stack || error.message;
});

restoreBatchState();
