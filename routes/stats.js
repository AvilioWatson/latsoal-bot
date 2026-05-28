import {readIndex} from "../lib/filestore.js";

const STATUS_KEYS = ["saved", "approved", "rejected"];
const LEVEL_KEYS = ["mudah", "sedang", "sulit"];
const DAY_MS = 24 * 60 * 60 * 1000;

function rate(part, total) {
  if (!total) return 0;
  return Number((part / total).toFixed(4));
}

function increment(target, key, amount = 1) {
  target[key] = (target[key] || 0) + amount;
}

function statusOf(entry) {
  return STATUS_KEYS.includes(entry.status) ? entry.status : "saved";
}

function newestIso(values) {
  const latest = values
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return latest ? latest.toISOString() : null;
}

export function buildStats(entries, now = new Date()) {
  const list = Array.isArray(entries) ? entries : [];
  const total = list.length;
  const byStatus = {saved: 0, approved: 0, rejected: 0};
  const bySubtes = {};
  const bySource = {};
  const byLevel = {mudah: 0, sedang: 0, sulit: 0};
  const since = now.getTime() - (7 * DAY_MS);
  const recent = [];
  const exportBatchIds = new Set();
  let duplicates = 0;
  let pendingExport = 0;

  for (const entry of list) {
    const status = statusOf(entry);
    const subtes = entry.subtes || "unknown";
    const source = entry.source || "unknown";
    const level = entry.level || "unknown";

    increment(byStatus, status);
    increment(bySource, source);
    increment(byLevel, level);

    if (!bySubtes[subtes]) {
      bySubtes[subtes] = {total: 0, saved: 0, approved: 0, rejected: 0};
    }
    bySubtes[subtes].total += 1;
    bySubtes[subtes][status] += 1;

    if (entry.is_duplicate) duplicates += 1;
    if (entry.export_batch_id) exportBatchIds.add(entry.export_batch_id);
    if (status === "approved" && !entry.exported_at) pendingExport += 1;

    const savedAt = new Date(entry.saved_at || 0);
    if (!Number.isNaN(savedAt.getTime()) && savedAt.getTime() >= since) {
      recent.push(entry);
    }
  }

  for (const key of LEVEL_KEYS) {
    byLevel[key] = byLevel[key] || 0;
  }

  const recentApproved = recent.filter((entry) => statusOf(entry) === "approved").length;
  const recentFallback = recent.filter((entry) => entry.source === "fallback").length;
  const fallbackRate = rate(recentFallback, recent.length);
  const duplicateRate = rate(duplicates, total);

  const warnings = [];
  if (fallbackRate > 0.20) {
    warnings.push({
      type: "high_fallback_rate",
      message: `Fallback rate 7 hari terakhir ${Math.round(fallbackRate * 100)}% - quota Gemini mungkin sering kena`,
      severity: "warn",
    });
  }
  if (duplicateRate > 0.12) {
    warnings.push({
      type: "high_duplicate_rate",
      message: `Duplicate rate ${Math.round(duplicateRate * 100)}% - variasi topik/prompt perlu ditambah`,
      severity: "warn",
    });
  }
  for (const [subtes, row] of Object.entries(bySubtes)) {
    if (row.approved < 5) {
      warnings.push({
        type: "subtes_low_approved",
        subtes,
        message: `${subtes} hanya punya ${row.approved} soal approved`,
        severity: "info",
      });
    }
  }
  if (pendingExport >= 10) {
    warnings.push({
      type: "pending_export",
      message: `${pendingExport} soal approved belum pernah di-export`,
      severity: "info",
    });
  }

  return {
    generated_at: now.toISOString(),
    total,
    by_status: byStatus,
    by_subtes: bySubtes,
    by_source: bySource,
    by_level: byLevel,
    last_7_days: {
      total_generated: recent.length,
      approved: recentApproved,
      fallback_rate: fallbackRate,
    },
    duplicate_rate: duplicateRate,
    export_batches: exportBatchIds.size,
    last_exported_at: newestIso(list.map((entry) => entry.exported_at)),
    pending_export: pendingExport,
    warnings,
  };
}

function send(response, body, contentType) {
  const buffer = Buffer.from(body, "utf-8");
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": buffer.length,
  });
  response.end(buffer);
}

export async function sendStatsJson(response) {
  const entries = await readIndex();
  send(response, JSON.stringify(buildStats(entries)), "application/json; charset=utf-8");
}

export function sendStatsPage(response) {
  send(response, statsHtml(), "text/html; charset=utf-8");
}

function statsHtml() {
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Stats / UTBK Content Desk</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500&display=swap" rel="stylesheet">
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      :root {
        --bg:#0c0c0e; --surface:#141417; --surface2:#1c1c21; --border:rgba(255,255,255,.08);
        --border2:rgba(255,255,255,.14); --text:#f0f0f2; --muted:#8a8a9a; --faint:#4a4a5a;
        --gold:#e8a830; --gold-dim:rgba(232,168,48,.12); --green:#3ecf8e; --red:#f66; --blue:#58afdd;
        --font-head:'Manrope',sans-serif; --font-body:'DM Sans',sans-serif;
      }
      body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 var(--font-body); -webkit-font-smoothing:antialiased; }
      .topbar { height:56px; display:flex; align-items:center; justify-content:space-between; padding:0 28px; background:var(--surface); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:5; }
      .brand { display:flex; align-items:center; gap:12px; min-width:0; }
      .mark { width:30px; height:30px; border-radius:8px; background:var(--gold); display:grid; place-items:center; color:#0c0c0e; font-family:var(--font-head); font-weight:800; }
      .eyebrow { margin:0 0 3px; font:700 10px/1 var(--font-head); letter-spacing:.14em; text-transform:uppercase; color:var(--gold); }
      h1, h2, h3, p { margin:0; }
      h1 { font:700 17px/1.2 var(--font-head); }
      .nav { display:flex; align-items:center; gap:10px; }
      .nav a { color:var(--muted); text-decoration:none; font-weight:600; font-size:13px; padding:7px 12px; border:1px solid var(--border); border-radius:6px; }
      .nav a:hover, .nav a.active { color:var(--text); border-color:var(--border2); background:var(--surface2); }
      main { max-width:1180px; margin:0 auto; padding:28px 24px 36px; }
      .header { display:flex; justify-content:space-between; gap:20px; align-items:flex-end; margin-bottom:18px; }
      .header h2 { font:750 28px/1.15 var(--font-head); letter-spacing:0; }
      .timestamp { color:var(--muted); margin-top:6px; }
      .warnings { display:grid; gap:10px; margin:0 0 18px; }
      .warning { border:1px solid rgba(232,168,48,.25); background:var(--gold-dim); color:#f4c46c; border-radius:10px; padding:11px 14px; font-weight:600; }
      .warning.info { border-color:rgba(88,175,221,.28); background:rgba(88,175,221,.11); color:#8dcfec; }
      .cards { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin-bottom:18px; }
      .card, .panel { background:linear-gradient(180deg,rgba(255,255,255,.03),rgba(255,255,255,.01)), var(--surface); border:1px solid var(--border); border-radius:12px; }
      .card { padding:18px; min-height:116px; }
      .label { color:var(--muted); font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
      .value { font:800 34px/1.1 var(--font-head); margin-top:16px; }
      .value.danger { color:var(--red); }
      .grid { display:grid; grid-template-columns:1.45fr 1fr; gap:18px; }
      .panel { padding:18px; margin-bottom:18px; overflow:hidden; }
      .panel h3 { font:750 14px/1.2 var(--font-head); letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:14px; }
      table { width:100%; border-collapse:collapse; }
      th, td { padding:11px 10px; border-bottom:1px solid var(--border); text-align:left; vertical-align:middle; }
      th { color:var(--faint); font-size:11px; letter-spacing:.09em; text-transform:uppercase; }
      td { color:var(--text); }
      tr:hover td { background:rgba(255,255,255,.025); }
      .bar-track { height:8px; width:100%; min-width:120px; border-radius:999px; background:var(--surface2); overflow:hidden; border:1px solid var(--border); }
      .bar-fill { height:100%; background:linear-gradient(90deg,var(--gold),#f0b840); border-radius:inherit; }
      .side-by-side { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
      .export-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
      .export-stat { padding:14px; border-radius:10px; background:var(--surface2); border:1px solid var(--border); }
      .export-stat strong { display:block; font:750 24px/1.1 var(--font-head); margin-top:7px; }
      .footer { display:flex; align-items:center; justify-content:space-between; gap:16px; color:var(--muted); }
      button { border:0; border-radius:6px; background:var(--gold); color:#0c0c0e; padding:10px 15px; font:750 13px/1 var(--font-head); cursor:pointer; }
      button:hover { background:#f0b840; }
      .toggle { display:flex; align-items:center; gap:8px; }
      input[type="checkbox"] { accent-color:var(--gold); }
      .empty { color:var(--muted); padding:16px 0; }
      noscript { display:block; margin:18px 24px; padding:12px 14px; border-radius:10px; background:var(--gold-dim); color:#f4c46c; }
      @media (max-width: 920px) {
        .cards, .grid, .side-by-side, .export-grid { grid-template-columns:1fr; }
        .header { align-items:flex-start; flex-direction:column; }
        main { padding:22px 16px 30px; }
        .topbar { padding:0 16px; }
      }
    </style>
  </head>
  <body>
    <header class="topbar">
      <div class="brand">
        <div class="mark">U</div>
        <div>
          <p class="eyebrow">UTBK Content Desk</p>
          <h1>Monitoring</h1>
        </div>
      </div>
      <nav class="nav" aria-label="Navigasi utama">
        <a href="/">Generator</a>
        <a href="/saved">Bank Review</a>
        <a class="active" href="/stats">Stats</a>
      </nav>
    </header>
    <noscript>Enable JavaScript untuk melihat data monitoring terbaru.</noscript>
    <main>
      <section class="header">
        <div>
          <p class="eyebrow">Stats</p>
          <h2>UTBK Content Desk - Monitoring</h2>
          <p class="timestamp" id="timestamp">Data per: memuat...</p>
        </div>
      </section>
      <section class="warnings" id="warnings"></section>
      <section class="cards" id="cards"></section>
      <section class="grid">
        <div class="panel">
          <h3>Progress per Subtes</h3>
          <div id="subtesTable"></div>
        </div>
        <div>
          <div class="side-by-side">
            <div class="panel">
              <h3>Sumber</h3>
              <div id="sourceTable"></div>
            </div>
            <div class="panel">
              <h3>Level</h3>
              <div id="levelTable"></div>
            </div>
          </div>
          <div class="panel">
            <h3>Export History</h3>
            <div class="export-grid" id="exportStats"></div>
          </div>
        </div>
      </section>
      <footer class="footer">
        <button type="button" id="refreshButton">Refresh</button>
        <label class="toggle"><input type="checkbox" id="autoRefresh" checked> Auto-refresh 60 detik</label>
      </footer>
    </main>
    <script>
      const rupiah = new Intl.NumberFormat('id-ID');
      let timer = null;

      function pct(value) {
        return Math.round((Number(value) || 0) * 100);
      }

      function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        }[char]));
      }

      function table(rows, columns) {
        if (!rows.length) return '<p class="empty">Belum ada data.</p>';
        return '<table><thead><tr>' + columns.map((col) => '<th>' + esc(col.label) + '</th>').join('') +
          '</tr></thead><tbody>' + rows.map((row) => '<tr>' + columns.map((col) => '<td>' + col.render(row) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
      }

      function render(data) {
        document.getElementById('timestamp').textContent = 'Data per: ' + new Date(data.generated_at).toLocaleString('id-ID');
        document.getElementById('warnings').innerHTML = (data.warnings || []).map((item) =>
          '<div class="warning ' + esc(item.severity) + '">' + esc(item.message) + '</div>'
        ).join('');

        const fallbackRate = pct(data.last_7_days.fallback_rate);
        document.getElementById('cards').innerHTML = [
          ['Total Soal Diproduksi', rupiah.format(data.total)],
          ['Total Approved', rupiah.format(data.by_status.approved || 0)],
          ['Generated 7 Hari Terakhir', rupiah.format(data.last_7_days.total_generated || 0)],
          ['Fallback Rate (7 Hari)', fallbackRate + '%', fallbackRate > 20 ? 'danger' : '']
        ].map(([label, value, cls]) => '<article class="card"><p class="label">' + esc(label) + '</p><p class="value ' + esc(cls || '') + '">' + esc(value) + '</p></article>').join('');

        const subtesRows = Object.entries(data.by_subtes || {}).sort((a, b) => a[0].localeCompare(b[0])).map(([name, row]) => ({name, ...row}));
        document.getElementById('subtesTable').innerHTML = table(subtesRows, [
          {label:'Subtes', render:(r) => esc(r.name)},
          {label:'Total', render:(r) => rupiah.format(r.total)},
          {label:'Approved', render:(r) => rupiah.format(r.approved)},
          {label:'Rejected', render:(r) => rupiah.format(r.rejected)},
          {label:'Saved', render:(r) => rupiah.format(r.saved)},
          {label:'Progress', render:(r) => {
            const width = r.total ? Math.round((r.approved / r.total) * 100) : 0;
            return '<div class="bar-track" title="' + width + '%"><div class="bar-fill" style="width:' + width + '%"></div></div>';
          }},
        ]);

        const sourceRows = Object.entries(data.by_source || {}).map(([name, count]) => ({name, count, percent: data.total ? count / data.total : 0}));
        document.getElementById('sourceTable').innerHTML = table(sourceRows, [
          {label:'Source', render:(r) => esc(r.name)},
          {label:'Total', render:(r) => rupiah.format(r.count)},
          {label:'%', render:(r) => pct(r.percent) + '%'},
        ]);

        const levelRows = Object.entries(data.by_level || {}).map(([name, count]) => ({name, count, percent: data.total ? count / data.total : 0}));
        document.getElementById('levelTable').innerHTML = table(levelRows, [
          {label:'Level', render:(r) => esc(r.name)},
          {label:'Total', render:(r) => rupiah.format(r.count)},
          {label:'%', render:(r) => pct(r.percent) + '%'},
        ]);

        document.getElementById('exportStats').innerHTML = [
          ['Batch export', rupiah.format(data.export_batches || 0)],
          ['Export terakhir', data.last_exported_at ? new Date(data.last_exported_at).toLocaleString('id-ID') : '-'],
          ['Approved belum export', rupiah.format(data.pending_export || 0)]
        ].map(([label, value]) => '<div class="export-stat"><span class="label">' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>').join('');
      }

      async function loadStats() {
        const response = await fetch('/stats', {headers: {'Accept': 'application/json'}});
        if (!response.ok) throw new Error('Gagal mengambil stats');
        render(await response.json());
      }

      function setAutoRefresh(active) {
        if (timer) clearInterval(timer);
        timer = active ? setInterval(loadStats, 60000) : null;
      }

      document.getElementById('refreshButton').addEventListener('click', loadStats);
      document.getElementById('autoRefresh').addEventListener('change', (event) => setAutoRefresh(event.target.checked));
      loadStats().catch((error) => {
        document.getElementById('warnings').innerHTML = '<div class="warning">' + esc(error.message) + '</div>';
      });
      setAutoRefresh(true);
    </script>
  </body>
</html>`;
}
