const $ = (selector) => document.querySelector(selector);
const editStatus = $("#editStatus");
const editTitle = $("#editTitle");
const editNote = $("#editNote");
const editError = $("#editError");
const reloadEditorButton = $("#reloadEditorButton");
const saveAndRenderButton = $("#saveAndRenderButton");
const questionEditorForm = $("#questionEditorForm");
const editMapel = $("#editMapel");
const editTopik = $("#editTopik");
const editLevel = $("#editLevel");
const editAnswer = $("#editAnswer");
const editAccount = $("#editAccount");
const editQuestion = $("#editQuestion");
const editExplanation = $("#editExplanation");
const editCaption = $("#editCaption");
const editHashtags = $("#editHashtags");
const editNeedsVisual = $("#editNeedsVisual");
const editImageCount = $("#editImageCount");
const imagePreviewNote = $("#imagePreviewNote");
const editImagePreviewList = $("#editImagePreviewList");
const choiceFields = Object.fromEntries(
  ["A", "B", "C", "D", "E"].map((key) => [key, $(`#editChoice${key}`)]),
);
const runId = window.location.pathname.split("/").filter(Boolean)[1] || "";

let currentMetadata = null;
let taxonomy = {topics: {}};
let isBusy = false;

function setStatus(text, state = "") {
  editStatus.textContent = text;
  editStatus.dataset.state = state || text.toLowerCase().replace(/\s+/g, "-");
}

function setBusy(busy) {
  isBusy = busy;
  reloadEditorButton.disabled = busy;
  saveAndRenderButton.disabled = busy || !currentMetadata;
  questionEditorForm.setAttribute("aria-busy", String(busy));
  $(".editor-image-panel")?.classList.toggle("is-rendering", busy);
}

function showError(error) {
  editError.hidden = false;
  editError.textContent = error.stack || error.message || String(error);
}

function clearError() {
  editError.hidden = true;
  editError.textContent = "";
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Permintaan gagal (${response.status}).`);
  return data;
}

function fillSelect(select, values, selectedValue = "") {
  select.innerHTML = "";
  const uniqueValues = [...new Set(values.filter(Boolean))];
  if (selectedValue && !uniqueValues.includes(selectedValue)) uniqueValues.push(selectedValue);
  uniqueValues.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  });
  select.value = selectedValue || uniqueValues[0] || "";
}

function populateMapel(selectedValue) {
  fillSelect(editMapel, Object.keys(taxonomy.topics || {}), selectedValue);
}

function populateTopik(mapel, selectedValue = "") {
  fillSelect(editTopik, taxonomy.topics?.[mapel] || [], selectedValue);
}

function renderImages(metadata) {
  const images = metadata?.web_files?.images || [];
  editImageCount.textContent = `${images.length} halaman`;
  editImagePreviewList.innerHTML = "";
  if (!images.length) {
    const empty = document.createElement("p");
    empty.className = "body-copy";
    empty.textContent = "Belum ada gambar. Simpan untuk membuat preview.";
    editImagePreviewList.append(empty);
    return;
  }
  const cacheKey = Date.now();
  images.forEach((src, index) => {
    const figure = document.createElement("figure");
    const image = document.createElement("img");
    image.src = `${src}?t=${cacheKey}`;
    image.alt = `Preview gambar ${index + 1}`;
    image.loading = index === 0 ? "eager" : "lazy";
    const caption = document.createElement("figcaption");
    caption.textContent = `Halaman ${index + 1}`;
    figure.append(image, caption);
    editImagePreviewList.append(figure);
  });
}

function renderMetadata(metadata) {
  currentMetadata = metadata;
  const question = metadata.question || {};
  const choices = question.pilihan || {};
  const caption = metadata.caption || {};
  populateMapel(question.mapel || "");
  populateTopik(editMapel.value, question.topik || "");
  editLevel.value = question.level || "sedang";
  editAnswer.value = String(question.jawaban || "A").toUpperCase();
  editAccount.value = question.akun || "@utbk_neareducation";
  editQuestion.value = question.soal || "";
  Object.entries(choiceFields).forEach(([key, field]) => {
    field.value = choices[key] || "";
  });
  editExplanation.value = question.pembahasan || "";
  editCaption.value = caption.caption || "";
  editHashtags.value = Array.isArray(caption.hashtag) ? caption.hashtag.join(" ") : "";
  editNeedsVisual.checked = Boolean(question.butuh_visual);
  editTitle.textContent = question.mapel && question.topik
    ? `${question.mapel}: ${question.topik}`
    : `Run ${runId}`;
  editNote.textContent = `Run ID: ${runId}. Ubah kolom, lalu simpan dan render ulang.`;
  renderImages(metadata);
}

function buildMetadataPayload() {
  if (!currentMetadata) throw new Error("Data soal belum selesai dimuat.");
  const payload = JSON.parse(JSON.stringify(currentMetadata));
  delete payload.web_files;
  delete payload.canonical_topik;
  payload.question = {
    ...(payload.question || {}),
    mapel: editMapel.value,
    topik: editTopik.value,
    level: editLevel.value,
    soal: editQuestion.value.trim(),
    pilihan: Object.fromEntries(
      Object.entries(choiceFields).map(([key, field]) => [key, field.value.trim()]),
    ),
    jawaban: editAnswer.value,
    pembahasan: editExplanation.value.trim(),
    akun: editAccount.value.trim() || "@utbk_neareducation",
    butuh_visual: editNeedsVisual.checked,
  };
  payload.caption = {
    ...(payload.caption || {}),
    caption: editCaption.value.trim(),
    hashtag: editHashtags.value.split(/\s+/).filter(Boolean),
  };
  return payload;
}

async function loadEditor() {
  clearError();
  setStatus("Memuat");
  setBusy(true);
  try {
    const [config, metadata] = await Promise.all([
      fetchJson("/config", {headers: {Accept: "application/json"}}),
      fetchJson(`/saved/${runId}`, {headers: {Accept: "application/json"}}),
    ]);
    taxonomy = config;
    renderMetadata(metadata);
    setStatus("Siap");
  } finally {
    setBusy(false);
  }
}

async function saveAndRender() {
  clearError();
  if (!questionEditorForm.reportValidity()) return;
  setBusy(true);
  let saved = false;
  try {
    setStatus("Menyimpan");
    const saveResult = await fetchJson(`/saved/${runId}/json`, {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(buildMetadataPayload()),
    });
    currentMetadata = saveResult.metadata;
    saved = true;
    setStatus("Merender");
    imagePreviewNote.textContent = "Renderer sedang membuat gambar baru...";
    await fetchJson(`/saved/${runId}/images`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
    });
    renderMetadata(await fetchJson(`/saved/${runId}`, {headers: {Accept: "application/json"}}));
    setStatus("Tersimpan");
    imagePreviewNote.textContent = "Gambar sudah diperbarui dari isi soal terbaru.";
  } catch (error) {
    if (saved) error.message = `Data tersimpan, tetapi render gambar gagal: ${error.message}`;
    throw error;
  } finally {
    setBusy(false);
  }
}

editMapel.addEventListener("change", () => populateTopik(editMapel.value));
questionEditorForm.addEventListener("input", () => {
  if (!isBusy) setStatus("Belum disimpan", "pending");
});
questionEditorForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveAndRender().catch((error) => {
    setStatus("Error", "error");
    imagePreviewNote.textContent = "Preview belum dapat diperbarui.";
    showError(error);
  });
});
reloadEditorButton.addEventListener("click", () => {
  loadEditor().catch((error) => {
    setStatus("Error", "error");
    showError(error);
  });
});

if (!/^\d{8}-\d{6}$/.test(runId)) {
  setStatus("Error", "error");
  showError(new Error("Run ID tidak valid."));
  setBusy(true);
} else {
  loadEditor().catch((error) => {
    setStatus("Error", "error");
    showError(error);
  });
}
