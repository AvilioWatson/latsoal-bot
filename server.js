import {spawn} from "node:child_process";
import {createReadStream} from "node:fs";
import {access, cp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  addEntry,
  createEntryFromMetadata,
  readIndex,
  removeEntry,
  updateEntry,
} from "./lib/filestore.js";
import {sendStatsJson, sendStatsPage} from "./routes/stats.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const FRONTEND = path.join(ROOT, "frontend");
const OUTPUTS = path.join(ROOT, "outputs");
const SAVED = path.join(ROOT, "saved");
const APPROVED = path.join(ROOT, "approved");
const PORT = Number(process.env.PORT || 8765);
const PYTHON = process.env.PYTHON || "python";
const GENERATOR_TIMEOUT_MS = Number(process.env.GENERATOR_TIMEOUT_MS || 60000);
const GENERATOR_TIMEOUT_LABEL = `${Math.max(1, Math.ceil(GENERATOR_TIMEOUT_MS / 1000))}s`;

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

async function buildWebFiles(routeBase, runId) {
  return {
    question: `${routeBase}/${runId}/soal.json`,
    caption: `${routeBase}/${runId}/caption.txt`,
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

function runGenerator(payload) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
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
    let settled = false;
    let timedOut = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.removeAllListeners("error");
      child.removeAllListeners("close");
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const finishResolve = (metadata) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(metadata);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      const elapsed = Date.now() - startedAt;
      console.error(`[TIMEOUT] run_id=unknown elapsed=${elapsed}ms`);
      child.kill("SIGKILL");
    }, GENERATOR_TIMEOUT_MS);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", finishReject);
    child.on("close", async (code) => {
      if (timedOut) {
        finishReject(Object.assign(
          new Error(`generator did not respond within ${GENERATOR_TIMEOUT_LABEL}`),
          {
            payload: {
              ok: false,
              error: "timeout",
              detail: `generator did not respond within ${GENERATOR_TIMEOUT_LABEL}`,
            },
          },
        ));
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch (error) {
        finishReject(new Error(`Output generator bukan JSON valid: ${error.message}`));
        return;
      }

      if (parsed && parsed.ok === false) {
        const error = new Error(parsed.detail || parsed.error || "Generator gagal.");
        error.payload = parsed;
        finishReject(error);
        return;
      }

      if (code !== 0) {
        const error = new Error(parsed.detail || stderr || `Generator keluar dengan kode ${code}.`);
        error.payload = parsed;
        finishReject(error);
        return;
      }
      try {
        parsed.web_files = await buildWebFiles(
          "/outputs",
          parsed.run_id,
        );
        finishResolve(parsed);
      } catch (error) {
        finishReject(error);
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
  const metadata = JSON.parse(await readFile(path.join(target, "metadata.json"), "utf-8"));
  await addEntry(createEntryFromMetadata(runId, metadata, {
    saved_at: savedAt,
    status: "saved",
    path: `saved/${runId}`,
  }));

  return {
    run_id: runId,
    saved_at: savedAt,
    saved_path: target,
    web_files: await buildWebFiles("/saved", runId),
  };
}

async function listSavedRuns() {
  const index = await readIndex();
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
      web_files: await buildWebFiles("/saved", item.run_id),
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

  const now = new Date().toISOString();
  const patch = {
    status,
    approved_at: status === "approved" ? now : null,
    rejected_at: status === "rejected" ? now : null,
  };
  return updateEntry(runId, patch);
}

async function deleteSavedRun(runId) {
  if (!isValidRunId(runId)) {
    throw new Error("Run ID tidak valid.");
  }

  const target = safeJoin(SAVED, runId);
  if (!target) {
    throw new Error("Path run tidak valid.");
  }

  await removeEntry(runId);
  await rm(target, {recursive: true, force: true});

  return {
    run_id: runId,
    deleted: true,
  };
}

async function exportApprovedRuns() {
  const index = await readIndex();
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
        question_file: path.join(destinationDir, "soal.json"),
        caption_file: path.join(destinationDir, "caption.txt"),
        web_files: {
          metadata: `/approved/${exportId}/${item.run_id}/metadata.json`,
          question: `/approved/${exportId}/${item.run_id}/soal.json`,
          caption: `/approved/${exportId}/${item.run_id}/caption.txt`,
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

  if (request.method === "GET" && route === "/stats") {
    const accept = request.headers.accept || "";
    if (accept.includes("text/html") && !accept.includes("application/json")) {
      sendStatsPage(response);
    } else {
      await sendStatsJson(response);
    }
    return;
  }

  if (request.method === "POST" && route === "/api/generate") {
    try {
      const payload = await readJsonBody(request);
      const metadata = await runGenerator(payload);
      sendJson(response, metadata);
    } catch (error) {
      if (error.payload) {
        sendJson(response, error.payload, 500);
      } else {
        sendError(response, 500, error.message);
      }
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
      metadata.web_files = await buildWebFiles("/saved", runId);
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

  if (request.method === "POST" && route === "/api/saved/delete") {
    try {
      const payload = await readJsonBody(request);
      const deleted = await deleteSavedRun(payload.run_id || "");
      sendJson(response, deleted);
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
  readIndex().catch((error) => {
    console.error(`[INDEX] rebuild failed: ${error.message}`);
  });
  console.log(`UTBK Content Desk: http://127.0.0.1:${PORT}`);
});
