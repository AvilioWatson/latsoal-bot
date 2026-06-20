import {buildStats, readStats} from "../services/stats-service.js";

export {buildStats};

function send(response, body, contentType) {
  const buffer = Buffer.from(body, "utf-8");
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": buffer.length,
  });
  response.end(buffer);
}

export async function sendStatsJson(response) {
  send(response, JSON.stringify(await readStats()), "application/json; charset=utf-8");
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
        color-scheme:light;
        --bg:#f5f1e8; --surface:#fffdf8; --surface2:#f3ede2; --border:rgba(78,65,47,.1);
        --border2:rgba(78,65,47,.16); --text:#342d25; --muted:#786f64; --faint:#a39a8e;
        --gold:#a88452; --gold-hover:#947344; --gold-dim:rgba(168,132,82,.14);
        --green:#66775f; --red:#9d645a; --blue:#7a8795;
        --font-head:'Manrope',sans-serif; --font-body:'DM Sans',sans-serif;
      }
      body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 var(--font-body); -webkit-font-smoothing:antialiased; }
      .topbar { height:64px; display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); align-items:center; gap:20px; padding:0 32px; background:var(--surface); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:5; }
      .brand { display:flex; align-items:center; gap:12px; min-width:0; }
      .mark { width:34px; height:34px; border-radius:10px; background:var(--gold); display:grid; place-items:center; color:var(--text); font-family:var(--font-head); font-weight:800; }
      .eyebrow { margin:0 0 3px; font:700 10px/1 var(--font-head); letter-spacing:.14em; text-transform:uppercase; color:var(--gold); }
      h1, h2, h3, p { margin:0; }
      h1 { font:700 17px/1.2 var(--font-head); }
      .nav { display:flex; align-items:center; justify-content:center; gap:4px; }
      .nav a { color:var(--muted); text-decoration:none; font-weight:600; font-size:13px; border-radius:9px; padding:8px 11px; }
      .nav a:hover, .nav a.active { color:var(--text); background:var(--surface2); }
      main { max-width:1180px; margin:0 auto; padding:28px 24px 36px; }
      .header { display:flex; justify-content:space-between; gap:20px; align-items:flex-end; margin-bottom:18px; }
      .header h2 { font:750 28px/1.15 var(--font-head); letter-spacing:0; }
      .timestamp { color:var(--muted); margin-top:6px; }
      .warnings { display:grid; gap:10px; margin:0 0 18px; }
      .warning { border:1px solid rgba(168,132,82,.2); background:var(--gold-dim); color:#745d3d; border-radius:14px; padding:12px 15px; font-weight:600; }
      .warning.info { border-color:rgba(122,135,149,.2); background:rgba(122,135,149,.09); color:#66727d; }
      .cards { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:0; overflow:hidden; border:1px solid var(--border); border-radius:16px; background:var(--surface); margin-bottom:18px; }
      .card, .panel { background:var(--surface); border:1px solid var(--border); border-radius:16px; }
      .card { padding:20px; min-height:116px; border:0; border-right:1px solid var(--border); border-radius:0; }
      .card:last-child { border-right:0; }
      .label { color:var(--muted); font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
      .value { font:800 34px/1.1 var(--font-head); margin-top:16px; }
      .value.danger { color:var(--red); }
      .grid { display:grid; grid-template-columns:1.45fr 1fr; gap:18px; }
      .metrics-grid { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr); gap:18px; align-items:start; }
      .token-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; margin-bottom:18px; }
      .panel { padding:18px; margin-bottom:18px; overflow:hidden; }
      .panel h3 { font:750 14px/1.2 var(--font-head); letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:14px; }
      .token-list { display:grid; gap:10px; }
      .token-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:5px 12px; align-items:baseline; padding:12px 14px; border:1px solid var(--border); border-radius:10px; background:var(--surface2); }
      .token-row span { color:var(--muted); font-weight:750; }
      .token-row strong { font:800 24px/1.1 var(--font-head); }
      .token-meta { grid-column:1 / -1; color:var(--faint); font-size:12px; }
      table { width:100%; border-collapse:collapse; }
      th, td { padding:11px 10px; border-bottom:1px solid var(--border); text-align:left; vertical-align:middle; }
      th { color:var(--faint); font-size:11px; letter-spacing:.09em; text-transform:uppercase; }
      td { color:var(--text); }
      tr:hover td { background:rgba(72,54,30,.04); }
      .bar-track { height:8px; width:100%; min-width:120px; border-radius:999px; background:var(--surface2); overflow:hidden; border:1px solid var(--border); }
      .bar-fill { height:100%; background:var(--gold); border-radius:inherit; }
      .side-by-side { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
      .subtes-toggle { border:0; background:transparent; color:var(--text); padding:0; font:700 13px/1.2 var(--font-head); cursor:pointer; text-align:left; }
      .subtes-toggle:hover { color:var(--gold); background:transparent; }
      .subtopic-row td { background:rgba(72,54,30,.025); color:var(--muted); font-size:13px; }
      .subtopic-name { padding-left:30px; }
      .export-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
      .export-stat { padding:14px; border-radius:10px; background:var(--surface2); border:1px solid var(--border); }
      .export-stat strong { display:block; font:750 24px/1.1 var(--font-head); margin-top:7px; }
      .footer { display:flex; align-items:center; justify-content:space-between; gap:16px; color:var(--muted); }
      button { border:0; border-radius:10px; background:var(--gold); color:var(--surface); padding:11px 16px; font:750 13px/1 var(--font-head); cursor:pointer; }
      button:hover { background:var(--gold-hover); }
      .toggle { display:flex; align-items:center; gap:8px; }
      input[type="checkbox"] { accent-color:var(--gold); }
      .empty { color:var(--muted); padding:16px 0; }
      noscript { display:block; margin:18px 24px; padding:12px 14px; border-radius:10px; background:var(--gold-dim); color:#8a6117; }
      @media (max-width: 920px) {
        .cards, .grid, .metrics-grid, .token-grid, .side-by-side, .export-grid { grid-template-columns:1fr; }
        .header { align-items:flex-start; flex-direction:column; }
        main { padding:22px 16px 30px; }
        .topbar { height:auto; min-height:56px; grid-template-columns:minmax(0,1fr); align-items:flex-start; padding:14px 16px; }
        .nav { justify-content:flex-start; flex-wrap:wrap; }
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
        <a href="/dashboard">Dashboard</a>
        <a class="active" href="/stats">Monitoring</a>
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
      <section class="token-grid">
        <div class="panel">
          <h3>Token Untuk Membuat Soal</h3>
          <div class="token-list" id="questionTokenStats"></div>
        </div>
        <div class="panel">
          <h3>Token Untuk Pembahasan AI</h3>
          <div class="token-list" id="explanationTokenStats"></div>
        </div>
      </section>
      <section class="metrics-grid">
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
      </section>
      <section class="panel">
        <h3>Soal Dibuat per Subtes</h3>
        <div id="subtesTable"></div>
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

      function progressBar(approved, total) {
        const width = total ? Math.round((approved / total) * 100) : 0;
        return '<div class="bar-track" title="' + width + '%"><div class="bar-fill" style="width:' + width + '%"></div></div>';
      }

      function renderTokenStats(targetId, usage) {
        const rows = [
          ['Gemini', usage?.gemini || {}],
          ['Kimi', usage?.kimi || {}],
        ];
        document.getElementById(targetId).innerHTML = rows.map(([label, row]) => (
          '<div class="token-row">' +
            '<span>' + esc(label) + '</span>' +
            '<strong>' + rupiah.format(row.total_tokens || 0) + '</strong>' +
            '<small class="token-meta">Input ' + rupiah.format(row.prompt_tokens || 0) + ' / Output ' + rupiah.format(row.output_tokens || 0) + '</small>' +
          '</div>'
        )).join('');
      }

      function renderSubtesTable(data) {
        const rows = Object.entries(data.by_subtes || {}).sort((a, b) => a[0].localeCompare(b[0]));
        if (!rows.length) {
          document.getElementById('subtesTable').innerHTML = '<p class="empty">Belum ada data.</p>';
          return;
        }
        const body = rows.map(([name, row], index) => {
          const parentId = 'subtes-' + index;
          const topics = Object.entries(row.topics || {}).sort((a, b) => a[0].localeCompare(b[0]));
          const parent = '<tr>' +
            '<td><button type="button" class="subtes-toggle" data-target="' + parentId + '" data-label="' + esc(name) + '">[+] ' + esc(name) + '</button></td>' +
            '<td>' + rupiah.format(row.total || 0) + '</td>' +
            '<td>' + rupiah.format(row.approved || 0) + '</td>' +
            '<td>' + rupiah.format(row.uploaded || 0) + '</td>' +
            '<td>' + rupiah.format(row.rejected || 0) + '</td>' +
            '<td>' + rupiah.format(row.saved || 0) + '</td>' +
            '<td>' + progressBar(row.approved || 0, row.total || 0) + '</td>' +
          '</tr>';
          const children = topics.map(([topic, topicRow]) => (
            '<tr class="subtopic-row" data-parent="' + parentId + '" hidden>' +
              '<td class="subtopic-name">' + esc(topic) + '</td>' +
              '<td>' + rupiah.format(topicRow.total || 0) + '</td>' +
              '<td>' + rupiah.format(topicRow.approved || 0) + '</td>' +
              '<td>' + rupiah.format(topicRow.uploaded || 0) + '</td>' +
              '<td>' + rupiah.format(topicRow.rejected || 0) + '</td>' +
              '<td>' + rupiah.format(topicRow.saved || 0) + '</td>' +
              '<td>' + progressBar(topicRow.approved || 0, topicRow.total || 0) + '</td>' +
            '</tr>'
          )).join('');
          return parent + children;
        }).join('');
        document.getElementById('subtesTable').innerHTML =
          '<table><thead><tr><th>Subtes / Subtopik</th><th>Total</th><th>Approved</th><th>Uploaded</th><th>Rejected</th><th>Saved</th><th>Progress</th></tr></thead><tbody>' +
          body +
          '</tbody></table>';
        document.querySelectorAll('.subtes-toggle').forEach((button) => {
          button.addEventListener('click', () => {
            const target = button.dataset.target;
            const rows = document.querySelectorAll('[data-parent="' + target + '"]');
            const expanded = rows.length ? rows[0].hidden : false;
            rows.forEach((row) => {
              row.hidden = !expanded;
            });
            button.textContent = (expanded ? '[-] ' : '[+] ') + (button.dataset.label || '');
          });
        });
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

        renderSubtesTable(data);
        renderTokenStats('questionTokenStats', data.token_usage?.question);
        renderTokenStats('explanationTokenStats', data.token_usage?.explanation);

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
