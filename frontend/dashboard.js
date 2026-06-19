const dashboardStatus = document.querySelector("#dashboardStatus");
const dashboardUpdatedAt = document.querySelector("#dashboardUpdatedAt");
const dashboardSummary = document.querySelector("#dashboardSummary");
const dashboardTableBody = document.querySelector("#dashboardTableBody");
const dashboardSubtestFilter = document.querySelector("#dashboardSubtestFilter");
const dashboardUploadFilter = document.querySelector("#dashboardUploadFilter");
const dashboardRefreshButton = document.querySelector("#dashboardRefreshButton");

const numberFormatter = new Intl.NumberFormat("id-ID");
let topicsBySubtest = {};
let savedItems = [];

function setDashboardStatus(text, state = "") {
  dashboardStatus.textContent = text;
  dashboardStatus.dataset.state = state || text.toLowerCase().replace(/\s+/g, "-");
}

function normalizeLevel(level) {
  const value = String(level || "").toLowerCase();
  return ["mudah", "sedang", "sulit"].includes(value) ? value : null;
}

function formatNumber(value) {
  return numberFormatter.format(Number(value) || 0);
}

function canonicalKey(value) {
  return String(value || "").trim().toLocaleLowerCase("id-ID");
}

const topicAliases = new Map([
  ["pengetahuan kuantitatif\u001fpersamaan linear", "Aljabar dan Fungsi"],
  ["pengetahuan kuantitatif\u001fpersamaan kuadrat", "Aljabar dan Fungsi"],
  ["pengetahuan kuantitatif\u001ffungsi linear", "Aljabar dan Fungsi"],
  ["pengetahuan kuantitatif\u001ffungsi kuadrat", "Aljabar dan Fungsi"],
  ["pengetahuan kuantitatif\u001faljabar linear", "Aljabar dan Fungsi"],
  ["pengetahuan kuantitatif\u001fsistem persamaan linear", "Aljabar dan Fungsi"],
  ["pengetahuan kuantitatif\u001fpertidaksamaan linear", "Aljabar dan Fungsi"],
  ["penalaran matematika\u001fpersamaan linear", "Aljabar dan Fungsi"],
  ["penalaran matematika\u001fpersamaan kuadrat", "Aljabar dan Fungsi"],
  ["penalaran matematika\u001ffungsi linear", "Aljabar dan Fungsi"],
  ["penalaran matematika\u001ffungsi kuadrat", "Aljabar dan Fungsi"],
  ["penalaran matematika\u001faljabar linear", "Aljabar dan Fungsi"],
  ["penalaran matematika\u001fsistem persamaan linear", "Aljabar dan Fungsi"],
  ["penalaran matematika\u001fpertidaksamaan linear", "Aljabar dan Fungsi"],
]);

function canonicalSubtestName(value) {
  const key = canonicalKey(value);
  return Object.keys(topicsBySubtest).find((subtest) => canonicalKey(subtest) === key) || value || "Tanpa Sub Tes";
}

function canonicalTopicName(subtest, value) {
  const topics = topicsBySubtest[subtest] || [];
  const key = canonicalKey(value);
  const alias = topicAliases.get(`${canonicalKey(subtest)}\u001f${key}`);
  const target = alias || value;
  const targetKey = canonicalKey(target);
  return topics.find((topic) => canonicalKey(topic) === targetKey) || target || "Tanpa Sub Topik";
}

function uploadPercent(uploaded, total) {
  if (!total) return 0;
  return Math.round((uploaded / total) * 100);
}

function createDashboardRows() {
  const rowsByKey = new Map();
  const subtestOrder = [];

  function ensureSubtest(subtest) {
    if (!subtestOrder.includes(subtest)) subtestOrder.push(subtest);
  }

  function ensureRow(subtest, topic) {
    const safeSubtest = subtest || "Tanpa Sub Tes";
    const safeTopic = topic || "Tanpa Sub Topik";
    const key = `${canonicalKey(safeSubtest)}\u001f${canonicalKey(safeTopic)}`;
    ensureSubtest(safeSubtest);
    if (!rowsByKey.has(key)) {
      rowsByKey.set(key, {
        key,
        subtest: safeSubtest,
        topic: safeTopic,
        mudah: 0,
        sedang: 0,
        sulit: 0,
        total: 0,
        uploaded: 0,
      });
    }
    return rowsByKey.get(key);
  }

  for (const [subtest, topics] of Object.entries(topicsBySubtest)) {
    ensureSubtest(subtest);
    for (const topic of topics) {
      ensureRow(subtest, topic);
    }
  }

  for (const item of savedItems) {
    const subtest = canonicalSubtestName(item.mapel);
    const topic = canonicalTopicName(subtest, item.canonical_topik || item.topik);
    const row = ensureRow(subtest, topic);
    const level = normalizeLevel(item.level);
    if (level) row[level] += 1;
    row.total += 1;
    if (item.uploaded_at) row.uploaded += 1;
  }

  return subtestOrder.flatMap((subtest) => (
    Array.from(rowsByKey.values())
      .filter((row) => row.subtest === subtest)
      .sort((a, b) => a.topic.localeCompare(b.topic, "id"))
  ));
}

function filteredRows(rows) {
  const subtest = dashboardSubtestFilter.value;
  const upload = dashboardUploadFilter.value;
  return rows.filter((row) => {
    const subtestOk = subtest === "all" || row.subtest === subtest;
    const uploadOk = upload === "all"
      || (upload === "uploaded" && row.uploaded > 0)
      || (upload === "not-uploaded" && row.uploaded < row.total);
    return subtestOk && uploadOk;
  });
}

function renderSummary(rows) {
  const totals = rows.reduce((acc, row) => {
    acc.total += row.total;
    acc.mudah += row.mudah;
    acc.sedang += row.sedang;
    acc.sulit += row.sulit;
    acc.uploaded += row.uploaded;
    return acc;
  }, {total: 0, mudah: 0, sedang: 0, sulit: 0, uploaded: 0});
  const percent = uploadPercent(totals.uploaded, totals.total);
  const cards = [
    ["Total seluruh soal", formatNumber(totals.total)],
    ["Total soal mudah", formatNumber(totals.mudah)],
    ["Total soal sedang", formatNumber(totals.sedang)],
    ["Total soal sulit", formatNumber(totals.sulit)],
    ["Total soal telah diupload", formatNumber(totals.uploaded)],
    ["Persentase upload", `${percent}%`],
  ];

  dashboardSummary.innerHTML = "";
  for (const [label, value] of cards) {
    const card = document.createElement("article");
    card.className = "dashboard-card";
    const cardLabel = document.createElement("p");
    cardLabel.className = "label";
    cardLabel.textContent = label;
    const cardValue = document.createElement("strong");
    cardValue.textContent = value;
    card.append(cardLabel, cardValue);
    dashboardSummary.append(card);
  }
}

function renderSubtestFilter(rows) {
  const currentValue = dashboardSubtestFilter.value || "all";
  const subtests = Array.from(new Set(rows.map((row) => row.subtest)));
  dashboardSubtestFilter.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "Semua Sub Tes";
  dashboardSubtestFilter.append(allOption);
  for (const subtest of subtests) {
    const option = document.createElement("option");
    option.value = subtest;
    option.textContent = subtest;
    dashboardSubtestFilter.append(option);
  }
  dashboardSubtestFilter.value = subtests.includes(currentValue) ? currentValue : "all";
}

function appendCountCell(row, value, variant = "") {
  const cell = document.createElement("td");
  cell.className = variant ? `number-cell ${variant}` : "number-cell";
  cell.textContent = formatNumber(value);
  row.append(cell);
}

function uploadStatus(uploaded, total) {
  if (!total) return "empty";
  if (uploaded >= total) return "complete";
  if (uploaded > 0) return "partial";
  return "empty";
}

function renderTable(rows) {
  dashboardTableBody.innerHTML = "";
  const visibleRows = filteredRows(rows);
  if (!visibleRows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "dashboard-empty";
    cell.textContent = "Tidak ada sub topik yang cocok dengan filter.";
    row.append(cell);
    dashboardTableBody.append(row);
    return;
  }

  const rowsBySubtest = Map.groupBy
    ? Map.groupBy(visibleRows, (row) => row.subtest)
    : visibleRows.reduce((map, row) => {
      if (!map.has(row.subtest)) map.set(row.subtest, []);
      map.get(row.subtest).push(row);
      return map;
    }, new Map());

  for (const [, groupRows] of rowsBySubtest) {
    groupRows.forEach((item, index) => {
      const row = document.createElement("tr");
      if (index === 0) {
        const subtestCell = document.createElement("th");
        subtestCell.scope = "rowgroup";
        subtestCell.rowSpan = groupRows.length;
        subtestCell.className = "subtest-group-cell";
        subtestCell.textContent = item.subtest;
        row.append(subtestCell);
      }

      const topicCell = document.createElement("td");
      topicCell.className = "topic-cell";
      topicCell.textContent = item.topic;
      row.append(topicCell);
      appendCountCell(row, item.mudah);
      appendCountCell(row, item.sedang);
      appendCountCell(row, item.sulit);
      appendCountCell(row, item.total, "total");

      const uploadedCell = document.createElement("td");
      const percent = uploadPercent(item.uploaded, item.total);
      const status = uploadStatus(item.uploaded, item.total);
      uploadedCell.innerHTML = `
        <div class="upload-cell" data-status="${status}">
          <div class="upload-count">
            <strong>${formatNumber(item.uploaded)}</strong>
            <span>/ ${formatNumber(item.total)}</span>
          </div>
          <div class="upload-progress">
            <div class="upload-meter" aria-label="Upload ${percent}% dari ${formatNumber(item.total)} soal">
              <span style="width: ${percent}%"></span>
            </div>
            <span class="upload-percent">${percent}%</span>
          </div>
          <span class="upload-state">
            ${status === "complete" ? "Lengkap" : status === "partial" ? "Sebagian" : "Belum ada"}
          </span>
        </div>
      `;
      row.append(uploadedCell);
      dashboardTableBody.append(row);
    });
  }
}

function renderDashboard() {
  const rows = createDashboardRows();
  renderSubtestFilter(rows);
  renderSummary(rows);
  renderTable(rows);
  dashboardUpdatedAt.textContent = `Data per: ${new Date().toLocaleString("id-ID")}`;
}

async function loadDashboard() {
  setDashboardStatus("Memuat", "loading");
  dashboardRefreshButton.disabled = true;
  try {
    const [configResponse, savedResponse] = await Promise.all([
      fetch("/config", {headers: {"Accept": "application/json"}}),
      fetch("/saved", {headers: {"Accept": "application/json"}}),
    ]);
    const config = await configResponse.json();
    const saved = await savedResponse.json();
    if (!configResponse.ok) throw new Error(config.error || "Gagal memuat config.");
    if (!savedResponse.ok) throw new Error(saved.error || "Gagal memuat saved.");
    topicsBySubtest = config.topics || {};
    savedItems = saved.items || [];
    renderDashboard();
    setDashboardStatus("Siap", "ready");
  } catch (error) {
    setDashboardStatus("Error", "error");
    dashboardUpdatedAt.textContent = error.message;
  } finally {
    dashboardRefreshButton.disabled = false;
  }
}

dashboardRefreshButton.addEventListener("click", loadDashboard);
dashboardSubtestFilter.addEventListener("change", renderDashboard);
dashboardUploadFilter.addEventListener("change", renderDashboard);

loadDashboard();
