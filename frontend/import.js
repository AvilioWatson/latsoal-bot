const elements = {
  status: document.querySelector("#importStatus"),
  account: document.querySelector("#importAccount"),
  input: document.querySelector("#jsonInput"),
  file: document.querySelector("#jsonFileInput"),
  drop: document.querySelector("#jsonDropZone"),
  inputMeta: document.querySelector("#inputMeta"),
  validate: document.querySelector("#validateImportButton"),
  clear: document.querySelector("#clearImportButton"),
  panel: document.querySelector("#validationPanel"),
  summary: document.querySelector("#validationSummary"),
  rows: document.querySelector("#validationRows"),
  selection: document.querySelector("#selectionNote"),
  import: document.querySelector("#importSelectedButton"),
  promptSubtest: document.querySelector("#promptSubtestSelect"),
  prompt: document.querySelector("#promptPreview"),
  template: document.querySelector("#templatePreview"),
  copyPrompt: document.querySelector("#copyPromptButton"),
  copyTemplate: document.querySelector("#copyTemplateButton"),
  renderPanel: document.querySelector("#renderPanel"),
  renderCount: document.querySelector("#renderCount"),
  renderProgress: document.querySelector("#renderProgress"),
  renderNote: document.querySelector("#renderNote"),
  retry: document.querySelector("#retryRenderButton"),
  scrollTop: document.querySelector("#importScrollTopButton"),
};

const RENDER_QUEUE_KEY = "latsoal-import-render-queue";
let questions = [];
let validationItems = [];
let failedRenderIds = [];
let topicsByMapel = {};
let importConfig = {};

function setStatus(text, state = "") {
  elements.status.textContent = text;
  elements.status.dataset.state = state || text.toLowerCase().replace(/\s+/g, "-");
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request gagal (${response.status}).`);
  return payload;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = original; }, 1200);
  } catch {
    throw new Error("Clipboard tidak tersedia. Blok teks lalu salin secara manual.");
  }
}

function parseInput() {
  const raw = elements.input.value.trim();
  if (!raw) throw new Error("Masukkan JSON array terlebih dahulu.");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("JSON paling luar harus berupa array.");
  return parsed;
}

function statusLabel(item) {
  if (item.status === "similar") return "Perlu konfirmasi";
  if (item.status === "exact_duplicate") return "Duplikat exact";
  if (item.status === "invalid") return "Invalid";
  return "Valid";
}

function matchedLabel(item) {
  const dedup = item.dedup || {};
  if (dedup.matched_run_id) return dedup.matched_run_id;
  if (Number.isInteger(dedup.matched_batch_index)) return `Batch #${dedup.matched_batch_index + 1}`;
  return "-";
}

function passageGroupText(item) {
  const passage = item.question?.bacaan;
  if (!passage?.id) return "";
  const group = item.passage_group;
  const number = group?.number || passage.nomor_soal || "-";
  const total = group?.total || passage.total_soal || "-";
  const size = Number(group?.size || 0);
  const label = group?.label || passage.id;
  const suffix = size > 1 ? ` \u00b7 ${size} item grup` : "";
  return `Bacaan ${label} \u00b7 Soal ${number}/${total}${suffix}`;
}

function passageIdNote(item) {
  const ids = item.passage_group?.ids || [];
  if (ids.length <= 1) return "";
  return `ID digabung: ${ids.join(", ")}`;
}

function syncQuestionTopic(index, topic) {
  const question = questions[index];
  const item = validationItems.find((candidate) => candidate.index === index);
  if (question) question.topik = topic;
  if (item?.question) item.question.topik = topic;
}

function renderTopicControl(item, title) {
  const mapel = item.question?.mapel || "";
  const topics = topicsByMapel[mapel] || [];
  if (!topics.length) return null;
  const label = document.createElement("label");
  label.className = "topic-fix-field";
  label.textContent = "Subtopik";
  const select = document.createElement("select");
  select.dataset.index = String(item.index);
  select.setAttribute("aria-label", `Ganti subtopik soal ${item.index + 1}`);
  for (const topic of topics) {
    const option = document.createElement("option");
    option.value = topic;
    option.textContent = topic;
    option.selected = topic === item.question?.topik;
    select.append(option);
  }
  select.addEventListener("change", () => {
    syncQuestionTopic(item.index, select.value);
    title.textContent = `${mapel || "Tanpa subtes"} · ${select.value}`;
  });
  label.append(select);
  return label;
}

function updateSelectionNote() {
  const selected = elements.rows.querySelectorAll('input[type="checkbox"]:checked').length;
  elements.selection.textContent = `${selected} dari ${validationItems.length} soal dipilih.`;
  elements.import.disabled = selected === 0;
}

function renderValidation(result) {
  validationItems = result.items || [];
  const summary = result.summary || {};
  elements.summary.innerHTML = "";
  for (const [label, value, state] of [
    ["Valid", summary.valid || 0, "valid"], ["Mirip", summary.similar || 0, "similar"],
    ["Exact", summary.exact_duplicate || 0, "exact"], ["Invalid", summary.invalid || 0, "invalid"],
  ]) {
    const span = document.createElement("span");
    span.dataset.state = state;
    span.textContent = `${label} ${value}`;
    elements.summary.append(span);
  }
  elements.rows.innerHTML = "";
  for (const item of validationItems) {
    const row = document.createElement("tr");
    row.dataset.state = item.status;
    const selectCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.index = String(item.index);
    checkbox.disabled = !item.selectable;
    checkbox.checked = Boolean(item.selected_by_default);
    checkbox.setAttribute("aria-label", `Pilih soal ${item.index + 1}`);
    checkbox.addEventListener("change", updateSelectionNote);
    selectCell.append(checkbox);
    const numberCell = document.createElement("td");
    numberCell.textContent = String(item.index + 1);
    const questionCell = document.createElement("td");
    const title = document.createElement("strong");
    title.textContent = `${item.question?.mapel || "Tanpa subtes"} · ${item.question?.topik || "Tanpa topik"}`;
    const excerpt = document.createElement("p");
    excerpt.textContent = String(item.question?.soal || "").replace(/\s+/g, " ").slice(0, 150) || "Soal tidak terbaca.";
    questionCell.append(title, excerpt);
    if (item.question?.bacaan?.id) {
      const passage = document.createElement("p");
      passage.className = "passage-meta";
      const number = item.question.bacaan.nomor_soal || "-";
      const total = item.question.bacaan.total_soal || "-";
      passage.textContent = `Bacaan ${item.question.bacaan.id} · Soal ${number}/${total}`;
      questionCell.append(passage);
      passage.textContent = passageGroupText(item);
      const idNote = passageIdNote(item);
      if (idNote) {
        const note = document.createElement("p");
        note.className = "passage-id-note";
        note.textContent = idNote;
        questionCell.append(note);
      }
    }
    const topicControl = renderTopicControl(item, title);
    if (topicControl) questionCell.append(topicControl);
    if (item.errors?.length) {
      const errors = document.createElement("ul");
      errors.className = "row-errors";
      for (const message of item.errors) { const li = document.createElement("li"); li.textContent = message; errors.append(li); }
      questionCell.append(errors);
    }
    if (item.warnings?.length) {
      const warnings = document.createElement("ul");
      warnings.className = "row-errors";
      for (const message of item.warnings) { const li = document.createElement("li"); li.textContent = message; warnings.append(li); }
      questionCell.append(warnings);
    }
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "import-status-badge";
    badge.dataset.state = item.status;
    badge.textContent = statusLabel(item);
    statusCell.append(badge);
    const similarityCell = document.createElement("td");
    similarityCell.textContent = item.dedup ? `${Math.round(Number(item.dedup.similarity || 0) * 100)}%` : "-";
    const matchCell = document.createElement("td");
    const match = matchedLabel(item);
    if (item.dedup?.matched_run_id) {
      const link = document.createElement("a");
      link.href = `/saved?run=${encodeURIComponent(match)}`;
      link.textContent = match;
      matchCell.append(link);
    } else matchCell.textContent = match;
    row.append(selectCell, numberCell, questionCell, statusCell, similarityCell, matchCell);
    elements.rows.append(row);
  }
  elements.panel.hidden = false;
  updateSelectionNote();
}

function syncPromptPreview() {
  const selected = elements.promptSubtest?.value || importConfig.default_subtest;
  const prompt = importConfig.prompts?.[selected] || importConfig.prompt || "";
  const template = importConfig.templates?.[selected] || importConfig.template || [];
  elements.prompt.textContent = prompt;
  elements.template.textContent = JSON.stringify(template, null, 2);
}

async function validateInput() {
  try {
    questions = parseInput();
    setStatus("Memvalidasi", "pending");
    elements.validate.disabled = true;
    const result = await api("/api/import/validate", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({questions}),
    });
    renderValidation(result);
    elements.inputMeta.textContent = `${questions.length} soal terbaca`;
    setStatus("Tervalidasi");
  } catch (error) {
    setStatus("Error", "error");
    elements.inputMeta.textContent = error instanceof SyntaxError ? `JSON tidak valid: ${error.message}` : error.message;
  } finally {
    elements.validate.disabled = false;
  }
}

function selectedIndices() {
  return [...elements.rows.querySelectorAll('input[type="checkbox"]:checked')].map((input) => Number(input.dataset.index));
}

async function importSelected() {
  const selected = selectedIndices();
  const similar = selected.filter((index) => validationItems.find((item) => item.index === index)?.status === "similar");
  try {
    setStatus("Mengimpor", "pending");
    elements.import.disabled = true;
    const result = await api("/api/import", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({questions, selected_indices: selected, confirmed_similar_indices: similar, account: elements.account.value}),
    });
    const runIds = (result.imported || []).map((item) => item.run_id);
    localStorage.setItem(RENDER_QUEUE_KEY, JSON.stringify(runIds));
    setStatus(`${runIds.length} tersimpan`);
    await renderQueue(runIds);
  } catch (error) {
    setStatus("Import gagal", "error");
    elements.selection.textContent = error.message;
  } finally {
    elements.import.disabled = false;
  }
}

async function renderQueue(runIds) {
  const queue = [...runIds];
  if (!queue.length) return;
  elements.renderPanel.hidden = false;
  failedRenderIds = [];
  elements.retry.hidden = true;
  for (let index = 0; index < queue.length; index += 1) {
    const runId = queue[index];
    elements.renderCount.textContent = `${index}/${queue.length}`;
    elements.renderProgress.style.width = `${Math.round((index / queue.length) * 100)}%`;
    elements.renderNote.textContent = `Merender ${runId}...`;
    try {
      await api(`/saved/${encodeURIComponent(runId)}/images`, {method: "POST"});
    } catch {
      failedRenderIds.push(runId);
    }
    localStorage.setItem(RENDER_QUEUE_KEY, JSON.stringify(queue.slice(index + 1)));
  }
  elements.renderCount.textContent = `${queue.length}/${queue.length}`;
  elements.renderProgress.style.width = "100%";
  localStorage.removeItem(RENDER_QUEUE_KEY);
  if (failedRenderIds.length) {
    elements.renderNote.textContent = `${failedRenderIds.length} render gagal. Data soal tetap tersimpan.`;
    elements.retry.hidden = false;
    setStatus("Render sebagian", "error");
  } else {
    elements.renderNote.textContent = "Semua gambar selesai dirender.";
    setStatus("Selesai");
  }
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { elements.inputMeta.textContent = "File melebihi 10 MB."; return; }
  elements.input.value = await file.text();
  elements.inputMeta.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
}

function clearAll() {
  elements.input.value = "";
  elements.file.value = "";
  elements.inputMeta.textContent = "Belum ada input";
  elements.panel.hidden = true;
  validationItems = [];
  questions = [];
  setStatus("Siap");
}

function syncScrollTopButton() {
  if (!elements.scrollTop) return;
  const visible = window.scrollY > 360;
  elements.scrollTop.dataset.visible = visible ? "true" : "false";
  elements.scrollTop.setAttribute("aria-hidden", visible ? "false" : "true");
  elements.scrollTop.tabIndex = visible ? 0 : -1;
}

function scrollPageToTop() {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({top: 0, behavior: reduceMotion ? "auto" : "smooth"});
}

elements.validate.addEventListener("click", validateInput);
elements.clear.addEventListener("click", clearAll);
elements.import.addEventListener("click", importSelected);
elements.file.addEventListener("change", () => loadFile(elements.file.files[0]));
elements.retry.addEventListener("click", () => renderQueue(failedRenderIds));
elements.copyPrompt.addEventListener("click", () => copyText(elements.prompt.textContent, elements.copyPrompt).catch((error) => setStatus(error.message, "error")));
elements.copyTemplate.addEventListener("click", () => copyText(elements.template.textContent, elements.copyTemplate).catch((error) => setStatus(error.message, "error")));
elements.promptSubtest?.addEventListener("change", syncPromptPreview);
for (const eventName of ["dragenter", "dragover"]) elements.drop.addEventListener(eventName, (event) => { event.preventDefault(); elements.drop.dataset.dragging = "true"; });
for (const eventName of ["dragleave", "drop"]) elements.drop.addEventListener(eventName, (event) => { event.preventDefault(); elements.drop.dataset.dragging = "false"; });
elements.drop.addEventListener("drop", (event) => loadFile(event.dataTransfer.files[0]));
elements.scrollTop?.addEventListener("click", scrollPageToTop);
window.addEventListener("scroll", syncScrollTopButton, {passive: true});
syncScrollTopButton();

api("/api/import/config").then((config) => {
  importConfig = config;
  topicsByMapel = config.topics || {};
  if (elements.promptSubtest) {
    elements.promptSubtest.innerHTML = "";
    for (const subtest of Object.keys(config.topics || {})) {
      const option = document.createElement("option");
      option.value = subtest;
      option.textContent = subtest;
      option.selected = subtest === config.default_subtest;
      elements.promptSubtest.append(option);
    }
  }
  syncPromptPreview();
}).catch((error) => { setStatus("Config gagal", "error"); elements.prompt.textContent = error.message; });

try {
  const pending = JSON.parse(localStorage.getItem(RENDER_QUEUE_KEY) || "[]");
  if (Array.isArray(pending) && pending.length) renderQueue(pending);
} catch { localStorage.removeItem(RENDER_QUEUE_KEY); }
