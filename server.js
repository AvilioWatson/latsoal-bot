import {spawn} from "node:child_process";
import {createReadStream} from "node:fs";
import {access, cp, mkdir, readFile, writeFile} from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {fileURLToPath} from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const FRONTEND = path.join(ROOT, "frontend");
const OUTPUTS = path.join(ROOT, "outputs");
const SAVED = path.join(ROOT, "saved");
const APPROVED = path.join(ROOT, "approved");
const PORT = Number(process.env.PORT || 8765);
const PYTHON = process.env.PYTHON || "python";

const TOPICS = {
  "Penalaran Umum": [
    "Penalaran deduktif",
    "Penalaran induktif",
    "Analogi",
    "Sebab akibat",
    "Penalaran analitis",
  ],
  "Pengetahuan dan Pemahaman Umum": [
    "Makna kata",
    "Hubungan antarkalimat",
    "Ide pokok",
    "Simpulan teks",
    "Kesesuaian pernyataan",
  ],
  "Pemahaman Bacaan dan Menulis": [
    "Kalimat efektif",
    "Ejaan",
    "Kohesi dan koherensi",
    "Paragraf padu",
    "Perbaikan kalimat",
  ],
  "Pengetahuan Kuantitatif": [
    "Aritmetika",
    "Aljabar dasar",
    "Perbandingan",
    "Peluang",
    "Statistika",
  ],
  "Literasi Bahasa Indonesia": [
    "Pemahaman teks informatif",
    "Pemahaman teks argumentatif",
    "Simpulan bacaan",
    "Tujuan penulis",
    "Evaluasi pernyataan",
  ],
  "Literasi Bahasa Inggris": [
    "Main idea",
    "Inference",
    "Vocabulary in context",
    "Author purpose",
    "Detail information",
  ],
  "Penalaran Matematika": [
    "Data dan ketidakpastian",
    "Bilangan",
    "Aljabar",
    "Geometri",
    "Pemodelan matematika",
  ],
};

function slugifySubtest(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const SAVED_PAGE_ROUTES = new Set(Object.keys(TOPICS).map((name) => `/saved/${slugifySubtest(name)}`));

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(response, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  response.end(body);
}

function sendError(response, status, message) {
  sendJson(response, {error: message}, status);
}

async function sendFile(response, filePath) {
  try {
    await access(filePath);
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {"Content-Type": MIME[extension] || "application/octet-stream"});
    createReadStream(filePath).pipe(response);
  } catch {
    sendError(response, 404, "File tidak ditemukan.");
  }
}

function safeJoin(base, requestPath) {
  const target = path.resolve(base, requestPath);
  const baseResolved = path.resolve(base);
  if (target !== baseResolved && !target.startsWith(baseResolved + path.sep)) {
    return null;
  }
  return target;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildWebFiles(routeBase, runId, directory) {
  const hasQuestionPng = await fileExists(path.join(directory, "post-soal.png"));
  const hasSolutionPng = await fileExists(path.join(directory, "post-pembahasan.png"));
  return {
    post_soal: `${routeBase}/${runId}/${hasQuestionPng ? "post-soal.png" : "post-soal.svg"}`,
    post_pembahasan: `${routeBase}/${runId}/${hasSolutionPng ? "post-pembahasan.png" : "post-pembahasan.svg"}`,
    post_soal_png: `${routeBase}/${runId}/post-soal.png`,
    post_pembahasan_png: `${routeBase}/${runId}/post-pembahasan.png`,
    post_soal_svg: `${routeBase}/${runId}/post-soal.svg`,
    post_pembahasan_svg: `${routeBase}/${runId}/post-pembahasan.svg`,
    metadata: `${routeBase}/${runId}/metadata.json`,
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

async function readSavedIndex() {
  const indexPath = path.join(SAVED, "index.json");
  try {
    const index = JSON.parse(await readFile(indexPath, "utf-8"));
    return Array.isArray(index) ? index : [];
  } catch {
    return [];
  }
}

async function writeSavedIndex(index) {
  await mkdir(SAVED, {recursive: true});
  await writeFile(path.join(SAVED, "index.json"), JSON.stringify(index, null, 2), "utf-8");
}

function runGenerator(payload) {
  return new Promise((resolve, reject) => {
    const args = [
      "content_generator.py",
      "--mapel",
      payload.mapel || "Penalaran Umum",
      "--topik",
      payload.topik || "Penalaran deduktif",
      "--level",
      payload.level || "sedang",
      "--mode",
      payload.mode || "auto",
      "--account",
      payload.account || "@namaakun",
    ];

    const child = spawn(PYTHON, args, {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Generator keluar dengan kode ${code}.`));
        return;
      }
      try {
        const metadata = JSON.parse(stdout);
        metadata.web_files = await buildWebFiles(
          "/outputs",
          metadata.run_id,
          path.join(OUTPUTS, metadata.run_id),
        );
        resolve(metadata);
      } catch (error) {
        reject(new Error(`Output generator bukan JSON valid: ${error.message}`));
      }
    });
  });
}

function isValidRunId(runId) {
  return /^\d{8}-\d{6}$/.test(runId);
}

async function saveRun(runId) {
  if (!isValidRunId(runId)) {
    throw new Error("Run ID tidak valid.");
  }

  const source = safeJoin(OUTPUTS, runId);
  const target = safeJoin(SAVED, runId);
  if (!source || !target) {
    throw new Error("Path run tidak valid.");
  }

  await access(path.join(source, "metadata.json"));
  await mkdir(SAVED, {recursive: true});
  await cp(source, target, {recursive: true, force: true});

  const savedAt = new Date().toISOString();
  const index = await readSavedIndex();

  const nextIndex = [
    {run_id: runId, saved_at: savedAt, status: "saved", path: target},
    ...index.filter((item) => item.run_id !== runId),
  ];
  await writeSavedIndex(nextIndex);

  return {
    run_id: runId,
    saved_at: savedAt,
    saved_path: target,
    web_files: await buildWebFiles("/saved", runId, target),
  };
}

async function listSavedRuns() {
  const index = await readSavedIndex();
  const items = [];
  for (const item of index) {
    if (!isValidRunId(item.run_id)) continue;
    const metadataPath = path.join(SAVED, item.run_id, "metadata.json");
    let metadata = null;
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    } catch {
      metadata = null;
    }
    items.push({
      run_id: item.run_id,
      saved_at: item.saved_at || null,
      status: item.status || "saved",
      source: metadata?.source || null,
      review_status: metadata?.review_status || null,
      mapel: metadata?.question?.mapel || null,
      topik: metadata?.question?.topik || null,
      level: metadata?.question?.level || null,
      jawaban: metadata?.question?.jawaban || null,
      web_files: await buildWebFiles("/saved", item.run_id, path.join(SAVED, item.run_id)),
    });
  }
  return items;
}

async function updateSavedStatus(runId, status) {
  const allowed = new Set(["saved", "approved", "rejected"]);
  if (!isValidRunId(runId)) {
    throw new Error("Run ID tidak valid.");
  }
  if (!allowed.has(status)) {
    throw new Error("Status tidak valid.");
  }

  const target = safeJoin(SAVED, runId);
  if (!target) {
    throw new Error("Path run tidak valid.");
  }
  await access(path.join(target, "metadata.json"));

  const index = await readSavedIndex();
  const existing = index.find((item) => item.run_id === runId);
  const next = {
    ...(existing || {run_id: runId, saved_at: new Date().toISOString(), path: target}),
    status,
    status_updated_at: new Date().toISOString(),
  };
  const nextIndex = [
    next,
    ...index.filter((item) => item.run_id !== runId),
  ];
  await writeSavedIndex(nextIndex);
  return next;
}

async function exportApprovedRuns() {
  const index = await readSavedIndex();
  const approved = index.filter((item) => item.status === "approved" && isValidRunId(item.run_id));
  const exportId = new Date().toISOString().replace(/[:.]/g, "-");
  const targetDir = path.join(APPROVED, exportId);
  await mkdir(targetDir, {recursive: true});

  const manifest = [];
  for (const item of approved) {
    const sourceDir = path.join(SAVED, item.run_id);
    const destinationDir = path.join(targetDir, item.run_id);
    try {
      await access(path.join(sourceDir, "metadata.json"));
      await cp(sourceDir, destinationDir, {recursive: true, force: true});
      const metadata = JSON.parse(await readFile(path.join(sourceDir, "metadata.json"), "utf-8"));
      manifest.push({
        run_id: item.run_id,
        saved_at: item.saved_at || null,
        status_updated_at: item.status_updated_at || null,
        mapel: metadata?.question?.mapel || null,
        topik: metadata?.question?.topik || null,
        level: metadata?.question?.level || null,
        jawaban: metadata?.question?.jawaban || null,
        caption_file: path.join(destinationDir, "caption.txt"),
        post_soal_png: path.join(destinationDir, "post-soal.png"),
        post_pembahasan_png: path.join(destinationDir, "post-pembahasan.png"),
        web_files: {
          metadata: `/approved/${exportId}/${item.run_id}/metadata.json`,
          caption: `/approved/${exportId}/${item.run_id}/caption.txt`,
          post_soal_png: `/approved/${exportId}/${item.run_id}/post-soal.png`,
          post_pembahasan_png: `/approved/${exportId}/${item.run_id}/post-pembahasan.png`,
        },
      });
    } catch {
      continue;
    }
  }

  await writeFile(path.join(targetDir, "manifest.json"), JSON.stringify({
    export_id: exportId,
    created_at: new Date().toISOString(),
    total: manifest.length,
    items: manifest,
  }, null, 2), "utf-8");

  return {
    export_id: exportId,
    total: manifest.length,
    path: targetDir,
    manifest: `/approved/${exportId}/manifest.json`,
  };
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const route = decodeURIComponent(url.pathname);

  if (request.method === "GET" && route === "/api/config") {
    sendJson(response, {topics: TOPICS});
    return;
  }

  if (request.method === "POST" && route === "/api/generate") {
    try {
      const payload = await readJsonBody(request);
      const metadata = await runGenerator(payload);
      sendJson(response, metadata);
    } catch (error) {
      sendError(response, 500, error.message);
    }
    return;
  }

  if (request.method === "POST" && route === "/api/save") {
    try {
      const payload = await readJsonBody(request);
      const saved = await saveRun(payload.run_id || "");
      sendJson(response, saved);
    } catch (error) {
      sendError(response, 500, error.message);
    }
    return;
  }

  if (request.method === "GET" && route === "/api/saved") {
    try {
      sendJson(response, {items: await listSavedRuns()});
    } catch (error) {
      sendError(response, 500, error.message);
    }
    return;
  }

  if (request.method === "GET" && route.startsWith("/api/saved/")) {
    try {
      const runId = route.replace("/api/saved/", "");
      if (!isValidRunId(runId)) {
        throw new Error("Run ID tidak valid.");
      }
      const runDir = path.join(SAVED, runId);
      const metadata = JSON.parse(await readFile(path.join(runDir, "metadata.json"), "utf-8"));
      metadata.web_files = await buildWebFiles("/saved", runId, runDir);
      sendJson(response, metadata);
    } catch (error) {
      sendError(response, 500, error.message);
    }
    return;
  }

  if (request.method === "POST" && route === "/api/saved/status") {
    try {
      const payload = await readJsonBody(request);
      const updated = await updateSavedStatus(payload.run_id || "", payload.status || "");
      sendJson(response, updated);
    } catch (error) {
      sendError(response, 500, error.message);
    }
    return;
  }

  if (request.method === "POST" && route === "/api/export/approved") {
    try {
      sendJson(response, await exportApprovedRuns());
    } catch (error) {
      sendError(response, 500, error.message);
    }
    return;
  }

  if (request.method === "GET" && route === "/") {
    await sendFile(response, path.join(FRONTEND, "index.html"));
    return;
  }

  if (
    request.method === "GET"
    && (route === "/saved.html" || route === "/saved" || SAVED_PAGE_ROUTES.has(route))
  ) {
    await sendFile(response, path.join(FRONTEND, "saved.html"));
    return;
  }

  if (request.method === "GET" && route.startsWith("/assets/")) {
    const target = safeJoin(FRONTEND, route.replace("/assets/", ""));
    if (!target) {
      sendError(response, 403, "Path tidak valid.");
      return;
    }
    await sendFile(response, target);
    return;
  }

  if (request.method === "GET" && route.startsWith("/outputs/")) {
    const target = safeJoin(OUTPUTS, route.replace("/outputs/", ""));
    if (!target) {
      sendError(response, 403, "Path tidak valid.");
      return;
    }
    await sendFile(response, target);
    return;
  }

  if (request.method === "GET" && route.startsWith("/saved/")) {
    const target = safeJoin(SAVED, route.replace("/saved/", ""));
    if (!target) {
      sendError(response, 403, "Path tidak valid.");
      return;
    }
    await sendFile(response, target);
    return;
  }

  if (request.method === "GET" && route.startsWith("/approved/")) {
    const target = safeJoin(APPROVED, route.replace("/approved/", ""));
    if (!target) {
      sendError(response, 403, "Path tidak valid.");
      return;
    }
    await sendFile(response, target);
    return;
  }

  if (request.method === "GET" && route === "/health") {
    const packageJson = await readFile(path.join(ROOT, "package.json"), "utf-8");
    sendJson(response, {ok: true, app: JSON.parse(packageJson).name});
    return;
  }

  sendError(response, 404, "Route tidak ditemukan.");
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    sendError(response, 500, error.message);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`UTBK Content Desk: http://127.0.0.1:${PORT}`);
});
