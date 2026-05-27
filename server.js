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
const PORT = Number(process.env.PORT || 8765);
const PYTHON = process.env.PYTHON || "python";

const TOPICS = {
  Matematika: ["Statistika", "Trigonometri", "Limit", "Peluang", "Fungsi"],
  Fisika: ["Kinematika", "Dinamika", "Gelombang", "Listrik", "Usaha dan Energi"],
  Kimia: ["Stoikiometri", "Asam Basa", "Termokimia", "Elektrokimia", "Ikatan Kimia"],
  Biologi: ["Sel", "Genetika", "Metabolisme", "Ekologi", "Sistem Organ"],
  TPS: ["Penalaran Umum", "Penalaran Kuantitatif", "Penalaran Analitis"],
  "Bahasa Indonesia": ["Pemahaman Bacaan", "Ejaan", "Tata Bahasa", "Paragraf"],
};

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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
    const args = [
      "content_generator.py",
      "--mapel",
      payload.mapel || "Matematika",
      "--topik",
      payload.topik || "Statistika",
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
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Generator keluar dengan kode ${code}.`));
        return;
      }
      try {
        const metadata = JSON.parse(stdout);
        metadata.web_files = {
          post_soal: `/outputs/${metadata.run_id}/post-soal.svg`,
          post_pembahasan: `/outputs/${metadata.run_id}/post-pembahasan.svg`,
          metadata: `/outputs/${metadata.run_id}/metadata.json`,
        };
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
  const indexPath = path.join(SAVED, "index.json");
  let index = [];
  try {
    index = JSON.parse(await readFile(indexPath, "utf-8"));
  } catch {
    index = [];
  }

  const nextIndex = [
    {run_id: runId, saved_at: savedAt, path: target},
    ...index.filter((item) => item.run_id !== runId),
  ];
  await writeFile(indexPath, JSON.stringify(nextIndex, null, 2), "utf-8");

  return {
    run_id: runId,
    saved_at: savedAt,
    saved_path: target,
    web_files: {
      metadata: `/saved/${runId}/metadata.json`,
      post_soal: `/saved/${runId}/post-soal.svg`,
      post_pembahasan: `/saved/${runId}/post-pembahasan.svg`,
    },
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

  if (request.method === "GET" && route === "/") {
    await sendFile(response, path.join(FRONTEND, "index.html"));
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
