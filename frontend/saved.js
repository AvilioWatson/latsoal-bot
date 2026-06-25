const sourceStatus = document.querySelector("#sourceStatus");
const savedList = document.querySelector("#savedList");
const savedLayout = document.querySelector(".saved-layout");
const savedPreview = document.querySelector(".saved-preview");
const savedSearch = document.querySelector("#savedSearch");
const savedStatusFilter = document.querySelector("#savedStatusFilter");
const refreshSavedButton = document.querySelector("#refreshSavedButton");
const exportApprovedButton = document.querySelector("#exportApprovedButton");
const subtestTabs = document.querySelector("#subtestTabs");
const subtopicTabs = document.querySelector("#subtopicTabs");
const closePreviewButton = document.querySelector("#closePreviewButton");
const reviewExplanationButton = document.querySelector("#reviewExplanationButton");
const aiReviewDraft = document.querySelector("#aiReviewDraft");
const aiReviewDraftScore = document.querySelector("#aiReviewDraftScore");
const aiReviewDraftSummary = document.querySelector("#aiReviewDraftSummary");
const aiReviewDraftJson = document.querySelector("#aiReviewDraftJson");
const applyAiReviewButton = document.querySelector("#applyAiReviewButton");
const cancelAiReviewButton = document.querySelector("#cancelAiReviewButton");
const approvePreviewButton = document.querySelector("#approvePreviewButton");
const rejectPreviewButton = document.querySelector("#rejectPreviewButton");
const markUploadedPreviewButton = document.querySelector("#markUploadedPreviewButton");
const deletePreviewButton = document.querySelector("#deletePreviewButton");
const editJsonLink = document.querySelector("#editJsonLink");
const copyCaptionButton = document.querySelector("#copyCaptionButton");
const previewTitle = document.querySelector("#previewTitle");
const runNote = document.querySelector("#runNote");
const questionText = document.querySelector("#questionText");
const choicesList = document.querySelector("#choicesList");
const captionText = document.querySelector("#captionText");
const hashtagText = document.querySelector("#hashtagText");
const validationScore = document.querySelector("#validationScore");
const metadataLink = document.querySelector("#metadataLink");
const downloadAllLink = document.querySelector("#downloadAllLink");
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
let activeSubtopic = "all";
let activePreviewRunId = "";
let activePreviewStatus = "";
let activePreviewSource = "";
let pendingExplanationReview = null;
let subtests = [];
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
      img.alt = "Preview gambar saved";
      elements.imagePreviewList.append(img);
    }
  },
  sourceText: sharedSourceText = (data) => data.source || "-",
} = window.LatsoalShared || {};

function slugifySubtest(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function topicLabel(item) {
  return item.canonical_topik || item.topik || "Tanpa subtopik";
}

function topicKey(value) {
  return String(value || "Tanpa subtopik").trim().toLowerCase();
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

function statusLabel(status) {
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  return "Saved";
}

function openPreviewPanel(runId) {
  savedLayout?.classList.add("has-preview");
  savedPreview?.setAttribute("aria-hidden", "false");
  savedList.querySelectorAll(".saved-item").forEach((card) => {
    card.dataset.active = card.dataset.runId === runId ? "true" : "false";
  });
}

function closePreviewPanel() {
  activePreviewRunId = "";
  clearAiReviewDraft();
  setPreviewActionState(null);
  savedLayout?.classList.remove("has-preview");
  savedPreview?.setAttribute("aria-hidden", "true");
  savedList.querySelectorAll(".saved-item").forEach((card) => {
    card.dataset.active = "false";
  });
}

function setPreviewStatus(status) {
  activePreviewStatus = status || "";
  const source = activePreviewSource || "-";
  sourceLabel.textContent = activePreviewStatus
    ? `${source} / ${statusLabel(activePreviewStatus)}`
    : source;
}

function selectedPreviewItem() {
  return savedItems.find((item) => item.run_id === activePreviewRunId) || null;
}

function clearAiReviewDraft() {
  pendingExplanationReview = null;
  aiReviewDraft.hidden = true;
  aiReviewDraftScore.textContent = "-";
  aiReviewDraftSummary.textContent = "";
  aiReviewDraftJson.textContent = "";
  applyAiReviewButton.disabled = false;
  cancelAiReviewButton.disabled = false;
  applyAiReviewButton.textContent = "Terapkan revisi";
}

function showAiReviewDraft(review) {
  pendingExplanationReview = review;
  const notes = [...(review.catatan || []), ...(review.saran_revisi || [])].filter(Boolean);
  aiReviewDraftScore.textContent = `Skor ${review.skor ?? "-"}`;
  aiReviewDraftSummary.textContent = notes[0]
    || "AI sudah menyiapkan JSON revisi. Periksa isinya sebelum diterapkan.";
  aiReviewDraftJson.textContent = JSON.stringify(review.question_revisi, null, 2);
  aiReviewDraft.hidden = false;
  aiReviewDraft.scrollIntoView({behavior: "smooth", block: "nearest"});
}

function setPreviewActionState(item = selectedPreviewItem()) {
  const hasPreview = Boolean(activePreviewRunId && item);
  const reviewPassed = Boolean(item?.explanation_review?.lolos);
  const isApproved = item?.status === "approved";
  const isRejected = item?.status === "rejected";
  const isUploaded = Boolean(item?.uploaded_at);
  approvePreviewButton.disabled = !hasPreview || (!isApproved && !reviewPassed);
  approvePreviewButton.setAttribute("aria-pressed", String(isApproved));
  approvePreviewButton.title = isApproved
    ? "Batalkan approve dan kembalikan ke Saved"
    : reviewPassed ? "Approve soal" : "Cek pembahasan AI sampai lolos sebelum approve.";
  rejectPreviewButton.disabled = !hasPreview;
  rejectPreviewButton.setAttribute("aria-pressed", String(isRejected));
  rejectPreviewButton.title = isRejected
    ? "Batalkan reject dan kembalikan ke Saved"
    : "Reject soal";
  markUploadedPreviewButton.disabled = !hasPreview;
  markUploadedPreviewButton.setAttribute("aria-pressed", String(isUploaded));
  markUploadedPreviewButton.title = isUploaded
    ? "Batalkan status upload"
    : "Tandai soal sudah diupload";
  deletePreviewButton.disabled = !hasPreview;
}

function reviewNote(data) {
  if (data.explanation_review?.lolos) return `Pembahasan sudah lolos cek AI dengan skor ${data.explanation_review.skor ?? "-"}.`;
  if (data.explanation_review && !data.explanation_review.lolos) return `Pembahasan belum lolos cek AI: ${(data.explanation_review.catatan || [])[0] || "perlu revisi."}`;
  if (data.dedup && data.dedup.is_duplicate) return `Kemungkinan duplikat: similarity ${data.dedup.similarity} dengan ${data.dedup.matched_run_id}.`;
  if (data.review_status === "ready") return "Konten siap direview final sebelum posting.";
  if (data.errors && data.errors.question) return `Mode fallback aktif: ${data.errors.question}`;
  return "Cek pembahasan dengan AI sebelum approve.";
}

function renderDebug(data) {
  sharedRenderDebug(data, {debugPanel, debugSource, debugText});
}

function renderImages(data) {
  sharedRenderImages(data, {imageCount, imagePreviewList}, {altPrefix: "Preview gambar saved"});
}

function matchesStatusFilter(item, status) {
  if (status === "all") return true;
  if (status === "approved") {
    return (item.status || "saved") === "approved" && !item.uploaded_at;
  }
  if (status === "uploaded") return Boolean(item.uploaded_at);
  return (item.status || "saved") === status;
}

function filteredSavedItems() {
  const query = savedSearch.value.trim().toLowerCase();
  const status = savedStatusFilter.value;
  return savedItems.filter((item) => {
    const statusOk = matchesStatusFilter(item, status);
    const subtestOk = activeSubtest === "all" || item.mapel === activeSubtest;
    const topicOk = activeSubtopic === "all" || topicKey(topicLabel(item)) === activeSubtopic;
    const haystack = [item.run_id, item.mapel, item.topik, item.canonical_topik, item.level, item.source, item.status].join(" ").toLowerCase();
    return subtestOk && topicOk && statusOk && (!query || haystack.includes(query));
  }).sort((left, right) => {
    const leftQuestion = left.soal_excerpt || "";
    const rightQuestion = right.soal_excerpt || "";
    return leftQuestion.localeCompare(rightQuestion, "id", {sensitivity: "base"})
      || String(left.topik || "").localeCompare(String(right.topik || ""), "id", {sensitivity: "base"})
      || String(left.run_id || "").localeCompare(String(right.run_id || ""), "id", {sensitivity: "base"});
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
      activeSubtopic = "all";
      window.history.pushState({}, "", tab.href);
      renderSubtestTabs();
      renderSubtopicTabs();
      renderSavedList();
    });
    subtestTabs.append(link);
  }
}

function renderSubtopicTabs() {
  subtopicTabs.innerHTML = "";
  if (activeSubtest === "all") {
    activeSubtopic = "all";
    subtopicTabs.hidden = true;
    return;
  }

  const topicNames = Array.from(new Set(
    savedItems
      .filter((item) => item.mapel === activeSubtest)
      .map(topicLabel)
      .filter(Boolean),
  )).sort((left, right) => left.localeCompare(right, "id", {sensitivity: "base"}));

  if (!topicNames.length) {
    activeSubtopic = "all";
    subtopicTabs.hidden = true;
    return;
  }

  const activeExists = topicNames.some((topic) => topicKey(topic) === activeSubtopic);
  if (activeSubtopic !== "all" && !activeExists) {
    activeSubtopic = "all";
  }

  subtopicTabs.hidden = false;
  const tabs = [{label: "Semua subtopik", value: "all"}, ...topicNames.map((topic) => ({
    label: topic,
    value: topicKey(topic),
  }))];

  for (const tab of tabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = tab.label;
    button.dataset.active = tab.value === activeSubtopic ? "true" : "false";
    button.addEventListener("click", () => {
      activeSubtopic = tab.value;
      renderSubtopicTabs();
      renderSavedList();
    });
    subtopicTabs.append(button);
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
  renderSubtopicTabs();
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
    row.dataset.runId = item.run_id;
    row.dataset.active = activePreviewRunId === item.run_id ? "true" : "false";
    row.style.setProperty("--item-index", String(index));
    row.innerHTML = `
      <div class="saved-card-top">
        <span data-subtest></span>
        <span data-status-pill></span>
      </div>
      <h3 data-topic></h3>
      <p class="saved-question-excerpt"></p>
      <div class="saved-card-meta">
        <span data-level></span>
        <span data-upload-state></span>
        <span data-run-id></span>
      </div>
    `;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Preview ${item.mapel || item.run_id}`);
    row.querySelector("[data-subtest]").textContent = item.mapel || "Tanpa subtes";
    row.querySelector("[data-status-pill]").textContent = statusLabel(item.status);
    row.querySelector("[data-topic]").textContent = item.topik || item.run_id;
    row.querySelector(".saved-question-excerpt").textContent = item.soal_excerpt || "Soal belum memiliki ringkasan.";
    row.querySelector("[data-level]").textContent = item.level || "-";
    row.querySelector("[data-upload-state]").textContent = item.uploaded_at ? "Uploaded" : "Belum upload";
    row.querySelector("[data-run-id]").textContent = item.run_id;
    row.addEventListener("click", () => loadSavedPreview(item.run_id));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      loadSavedPreview(item.run_id);
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
  renderSubtopicTabs();
  renderSavedList();
}

async function loadSavedPreview(runId) {
  clearAiReviewDraft();
  setStatus("Loading");
  activePreviewRunId = runId;
  openPreviewPanel(runId);
  const selectedItem = savedItems.find((item) => item.run_id === runId);
  previewTitle.textContent = selectedItem?.mapel
    ? `${selectedItem.mapel}: ${selectedItem.topik}`
    : "Memuat preview";
  runNote.textContent = "Memuat detail soal.";
  reviewExplanationButton.disabled = true;
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
  activePreviewSource = sharedSourceText(data);
  setPreviewStatus(savedItems.find((item) => item.run_id === runId)?.status || "saved");
  setPreviewActionState(selectedItem);
  validationScore.textContent = `Skor ${validation.skor ?? "-"}`;
  runNote.textContent = reviewNote(data);
  renderImages(data);
  reviewExplanationButton.disabled = false;
  generateImageButton.disabled = false;
  deleteImageButton.disabled = !(data.web_files?.images || []).length;
  questionText.textContent = sharedFormatQuestionText(question.soal);
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
  editJsonLink.href = `/edit/${runId}`;
  editJsonLink.hidden = false;
  downloadAllLink.href = `/download/saved/${runId}`;
  downloadAllLink.hidden = false;
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
  editJsonLink.hidden = true;
  editJsonLink.href = "#";
  downloadAllLink.hidden = true;
  downloadAllLink.href = "#";
  copyCaptionButton.disabled = true;
  reviewExplanationButton.disabled = true;
  setPreviewActionState(null);
  debugPanel.hidden = true;
  closePreviewPanel();
}

async function reviewExplanation() {
  if (!activePreviewRunId) return;
  reviewExplanationButton.disabled = true;
  reviewExplanationButton.textContent = "Checking";
  setStatus("Reviewing");
  try {
    const response = await fetch(`/saved/${activePreviewRunId}/explanation-review`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({provider: "gemini"}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Cek pembahasan gagal.");
    if (!data.explanation_review?.question_revisi) {
      throw new Error("AI tidak mengembalikan draft JSON revisi.");
    }
    showAiReviewDraft(data.explanation_review);
    setStatus("Draft ready");
    runNote.textContent = "Review selesai. JSON asli belum berubah; periksa draft lalu pilih Terapkan atau Cancel.";
  } catch (error) {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "explanation-review";
    debugText.textContent = error.stack || error.message;
  } finally {
    reviewExplanationButton.disabled = false;
    reviewExplanationButton.textContent = "Cek pembahasan AI";
  }
}

async function applyAiReviewDraft() {
  if (!activePreviewRunId || !pendingExplanationReview) return;
  const runId = activePreviewRunId;
  applyAiReviewButton.disabled = true;
  cancelAiReviewButton.disabled = true;
  applyAiReviewButton.textContent = "Menerapkan";
  setStatus("Applying");
  try {
    const response = await fetch(`/saved/${runId}/explanation-review/apply`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        question_revisi: pendingExplanationReview.question_revisi,
        explanation_review: pendingExplanationReview,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Penerapan revisi gagal.");
    clearAiReviewDraft();
    await loadSavedList();
    await loadSavedPreview(runId);
    setStatus("Applied");
    runNote.textContent = "Revisi AI sudah diterapkan ke metadata.json dan soal.json.";
  } catch (error) {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "explanation-review/apply";
    debugText.textContent = error.stack || error.message;
  } finally {
    applyAiReviewButton.disabled = false;
    cancelAiReviewButton.disabled = false;
    applyAiReviewButton.textContent = "Terapkan revisi";
  }
}

function cancelAiReviewDraft() {
  if (!pendingExplanationReview) return;
  clearAiReviewDraft();
  setStatus("Canceled");
  runNote.textContent = "Draft AI dibatalkan. JSON asli tidak berubah.";
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
  setStatus(status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Saved");
  await loadSavedList();
  if (activePreviewRunId === runId) {
    setPreviewStatus(status);
    runNote.textContent = `Status review sekarang ${statusLabel(status)}.`;
    setPreviewActionState(selectedPreviewItem());
  }
}

async function toggleUploaded(runId) {
  const item = savedItems.find((entry) => entry.run_id === runId);
  const wasUploaded = Boolean(item?.uploaded_at);
  const action = wasUploaded ? "unuploaded" : "uploaded";
  setStatus("Updating");
  const response = await fetch(`/saved/${runId}/${action}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = `saved/${action}`;
    debugText.textContent = data.error || "Update upload gagal.";
    return;
  }
  setStatus(wasUploaded ? "Not uploaded" : "Uploaded");
  await loadSavedList();
  if (activePreviewRunId === runId) {
    runNote.textContent = wasUploaded
      ? "Status upload dibatalkan."
      : `Sudah diupload pada ${new Date(data.uploaded_at).toLocaleString("id-ID")}.`;
    setPreviewActionState(selectedPreviewItem());
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
reviewExplanationButton.addEventListener("click", reviewExplanation);
applyAiReviewButton.addEventListener("click", applyAiReviewDraft);
cancelAiReviewButton.addEventListener("click", cancelAiReviewDraft);
approvePreviewButton.addEventListener("click", () => {
  if (!activePreviewRunId) return;
  const nextStatus = activePreviewStatus === "approved" ? "saved" : "approved";
  updateSavedStatus(activePreviewRunId, nextStatus);
});
rejectPreviewButton.addEventListener("click", () => {
  if (!activePreviewRunId) return;
  const nextStatus = activePreviewStatus === "rejected" ? "saved" : "rejected";
  updateSavedStatus(activePreviewRunId, nextStatus);
});
markUploadedPreviewButton.addEventListener("click", () => {
  if (activePreviewRunId) toggleUploaded(activePreviewRunId);
});
deletePreviewButton.addEventListener("click", () => {
  if (activePreviewRunId) deleteSavedRun(activePreviewRunId);
});
closePreviewButton.addEventListener("click", closePreviewPanel);

savedSearch.addEventListener("input", () => renderSavedList());
savedStatusFilter.addEventListener("change", () => {
  renderSubtopicTabs();
  renderSavedList();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && savedLayout?.classList.contains("has-preview")) {
    closePreviewPanel();
  }
});

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
  await sharedCopyCaption({captionText, hashtagText, debugPanel, debugSource, debugText}, setStatus);
});

async function init() {
  await loadConfig();
  closePreviewPanel();
  await loadSavedList();
}

window.addEventListener("popstate", () => {
  activeSubtest = subtestFromPath();
  activeSubtopic = "all";
  renderSubtestTabs();
  renderSubtopicTabs();
  renderSavedList();
});

init().catch((error) => {
  setStatus("Error");
  debugPanel.hidden = false;
  debugSource.textContent = "saved";
  debugText.textContent = error.stack || error.message;
});
