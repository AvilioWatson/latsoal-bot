import {spawn} from "node:child_process";
import {access, cp, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {
  addEntry,
  createEntryFromMetadata,
  readIndex,
  removeEntry,
  updateEntry,
} from "../lib/filestore.js";
import {errorStatus, readJsonBody, sendError, sendJson} from "../lib/http.js";
import {OUTPUTS, ROOT, SAVED, buildStoragePath, buildWebFiles, isValidRunId, pathFromIndexEntry, safeJoin} from "../lib/paths.js";

const DEFAULT_PYTHON = process.env.PYTHON || "python";

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function retargetMetadataFiles(metadata, targetDir) {
  const artifactName = (file) => String(file || "").split(/[\\/]/).pop();
  metadata.files = metadata.files || {};
  metadata.files.question = path.join(targetDir, "soal.json");
  metadata.files.caption = path.join(targetDir, "caption.txt");
  for (const key of ["image", "thumbnail", "explanation"]) {
    if (metadata.files[key]) metadata.files[key] = path.join(targetDir, artifactName(metadata.files[key]));
  }
  for (const key of ["images", "explanations"]) {
    if (Array.isArray(metadata.files[key])) {
      metadata.files[key] = metadata.files[key].map((file) => path.join(targetDir, artifactName(file)));
    }
  }
  return metadata;
}

async function resolveSavedRun(runId) {
  if (!isValidRunId(runId)) return null;
  const index = await readIndex();
  const entry = index.find((item) => item.run_id === runId);
  const candidates = [];
  if (entry) {
    candidates.push(pathFromIndexEntry(entry, "saved"));
  }
  candidates.push(runId);
  for (const candidate of candidates) {
    const target = safeJoin(SAVED, candidate);
    if (!target) continue;
    try {
      await access(path.join(target, "metadata.json"));
      return {dir: target, artifactPath: candidate, entry};
    } catch {
      continue;
    }
  }
  return null;
}

async function resolveOutputRun(runId) {
  if (!isValidRunId(runId)) return null;
  const candidates = [runId];
  async function collect(dir) {
    let names;
    try {
      names = await readdir(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const dirent of names) {
      const target = path.join(dir, dirent.name);
      if (!dirent.isDirectory()) continue;
      if (dirent.name === runId) {
        candidates.unshift(path.relative(OUTPUTS, target).replace(/\\/g, "/"));
      } else {
        await collect(target);
      }
    }
  }
  await collect(OUTPUTS);
  for (const candidate of candidates) {
    const target = safeJoin(OUTPUTS, candidate);
    if (!target) continue;
    try {
      await access(path.join(target, "metadata.json"));
      return {dir: target, artifactPath: candidate};
    } catch {
      continue;
    }
  }
  return null;
}

async function saveRun(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }

  const sourceRun = await resolveOutputRun(runId);
  if (!sourceRun) {
    throw requestError(404, "Output run tidak ditemukan.");
  }
  const metadata = JSON.parse(await readFile(path.join(sourceRun.dir, "metadata.json"), "utf-8"));
  const artifactPath = buildStoragePath(metadata.question || {}, runId);
  const target = safeJoin(SAVED, artifactPath);
  if (!target) {
    throw requestError(400, "Path run tidak valid.");
  }
  await mkdir(SAVED, {recursive: true});
  await mkdir(path.dirname(target), {recursive: true});
  await cp(sourceRun.dir, target, {recursive: true, force: true});

  const savedAt = new Date().toISOString();
  metadata.storage_path = artifactPath;
  retargetMetadataFiles(metadata, target);
  await writeFile(path.join(target, "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");
  await addEntry(createEntryFromMetadata(runId, metadata, {
    saved_at: savedAt,
    status: "saved",
    path: `saved/${artifactPath}`,
  }));

  return {
    run_id: runId,
    saved_at: savedAt,
    saved_path: target,
    web_files: buildWebFiles("/saved", artifactPath, metadata.files),
  };
}

async function listSavedRuns() {
  const index = await readIndex();
  const items = [];
  for (const item of index) {
    if (!isValidRunId(item.run_id)) continue;
    const artifactPath = pathFromIndexEntry(item, "saved");
    const metadataPath = path.join(SAVED, artifactPath, "metadata.json");
    let metadata = null;
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    } catch {
      metadata = null;
    }
    items.push({
      run_id: item.run_id,
      saved_at: item.saved_at || null,
      uploaded_at: item.uploaded_at || null,
      status: item.status || "saved",
      source: metadata?.source || null,
      review_status: metadata?.review_status || null,
      mapel: metadata?.question?.mapel || null,
      topik: metadata?.question?.topik || null,
      level: metadata?.question?.level || null,
      jawaban: metadata?.question?.jawaban || null,
      web_files: buildWebFiles("/saved", artifactPath, metadata?.files),
    });
  }
  return items;
}

async function updateSavedStatus(runId, status) {
  const allowed = new Set(["saved", "approved", "rejected"]);
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  if (!allowed.has(status)) {
    throw requestError(400, "Status tidak valid.");
  }

  const resolved = await resolveSavedRun(runId);
  if (!resolved) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const now = new Date().toISOString();
  return updateEntry(runId, {
    status,
    status_updated_at: now,
    approved_at: status === "approved" ? now : null,
    rejected_at: status === "rejected" ? now : null,
  });
}

async function markSavedUploaded(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }

  const resolved = await resolveSavedRun(runId);
  if (!resolved) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const now = new Date().toISOString();
  return updateEntry(runId, {
    uploaded_at: now,
  });
}

async function unmarkSavedUploaded(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }

  const resolved = await resolveSavedRun(runId);
  if (!resolved) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  return updateEntry(runId, {
    uploaded_at: null,
  });
}

async function deleteSavedRun(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }

  const resolved = await resolveSavedRun(runId);
  const target = resolved?.dir;
  if (!target) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  await removeEntry(runId);
  await rm(target, {recursive: true, force: true});

  return {
    run_id: runId,
    deleted: true,
  };
}

function runImageRenderer(metadataPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(DEFAULT_PYTHON, [
      "content_generator.py",
      "--render-images",
      metadataPath,
    ], {
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
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error(stderr || "Renderer gambar tidak mengembalikan JSON valid."));
        return;
      }
      if (code !== 0 || parsed.ok === false) {
        reject(new Error(parsed.detail || stderr || "Render gambar gagal."));
        return;
      }
      resolve(parsed);
    });
  });
}

async function generateSavedImages(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  const resolved = await resolveSavedRun(runId);
  const runDir = resolved?.dir;
  const artifactPath = resolved?.artifactPath || runId;
  if (!runDir) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }
  const metadataPath = path.join(runDir, "metadata.json");
  try {
    await access(metadataPath);
  } catch {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const result = await runImageRenderer(metadataPath);
  return {
    run_id: runId,
    files: result.files,
    web_files: buildWebFiles("/saved", artifactPath, result.files),
  };
}

async function deleteSavedImages(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  const resolved = await resolveSavedRun(runId);
  const runDir = resolved?.dir;
  const artifactPath = resolved?.artifactPath || runId;
  if (!runDir) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }
  const metadataPath = path.join(runDir, "metadata.json");
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
  } catch {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const imageFiles = new Set([
    metadata?.files?.thumbnail,
    metadata?.files?.image,
    metadata?.files?.explanation,
    ...(Array.isArray(metadata?.files?.images) ? metadata.files.images : []),
    ...(Array.isArray(metadata?.files?.explanations) ? metadata.files.explanations : []),
  ].filter(Boolean));
  for (const name of await readdir(runDir)) {
    if (/^(?:\d+\.jpe?g|thumbnail\.(?:png|jpe?g|tex|pdf|aux|log)|post-\d+\.(?:png|jpe?g|tex|pdf|aux|log)|pembahasan-\d+\.(?:jpe?g|tex|pdf|aux|log))$/i.test(name)) {
      imageFiles.add(name);
    }
  }
  for (const imageFile of imageFiles) {
    const target = safeJoin(runDir, path.basename(String(imageFile)));
    if (target) {
      await rm(target, {force: true});
    }
  }
  metadata.files = metadata.files || {};
  delete metadata.files.thumbnail;
  delete metadata.files.image;
  delete metadata.files.explanation;
  metadata.files.images = [];
  metadata.files.explanations = [];
  metadata.image_deleted_at = new Date().toISOString();
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

  return {
    run_id: runId,
    files: metadata.files,
    web_files: buildWebFiles("/saved", artifactPath, metadata.files),
  };
}

async function sendSavedMetadata(response, runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  const resolved = await resolveSavedRun(runId);
  const runDir = resolved?.dir;
  const artifactPath = resolved?.artifactPath || runId;
  if (!runDir) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path.join(runDir, "metadata.json"), "utf-8"));
  } catch {
    throw requestError(404, "Saved run tidak ditemukan.");
  }
  metadata.web_files = buildWebFiles("/saved", artifactPath, metadata.files);
  sendJson(response, metadata);
}

function wantsJson(request) {
  const accept = request.headers.accept || "";
  return accept.includes("application/json") || !accept.includes("text/html");
}

function savedRunRoute(route) {
  const parts = route.split("/").filter(Boolean);
  if (parts[0] !== "saved" || parts.length < 2) return null;
  return isValidRunId(parts[1]) ? parts : null;
}

export async function handle(request, response, route) {
  if (request.method === "POST" && (route === "/api/save" || route === "/saved")) {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await saveRun(payload.run_id || ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (
    request.method === "GET"
    && (route === "/api/saved" || (route === "/saved" && wantsJson(request)))
  ) {
    try {
      sendJson(response, {items: await listSavedRuns()});
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  const savedRoute = savedRunRoute(route);
  if (request.method === "GET" && savedRoute?.length === 2 && wantsJson(request)) {
    try {
      await sendSavedMetadata(response, savedRoute[1]);
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "GET" && route.startsWith("/api/saved/")) {
    try {
      await sendSavedMetadata(response, route.replace("/api/saved/", ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "status") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await updateSavedStatus(savedRoute[1], payload.status || ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "uploaded") {
    try {
      sendJson(response, await markSavedUploaded(savedRoute[1]));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "unuploaded") {
    try {
      sendJson(response, await unmarkSavedUploaded(savedRoute[1]));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "images") {
    try {
      sendJson(response, await generateSavedImages(savedRoute[1]));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (
    (request.method === "DELETE" && savedRoute?.length === 3 && savedRoute[2] === "images")
    || (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "delete-images")
  ) {
    try {
      sendJson(response, await deleteSavedImages(savedRoute[1]));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && route === "/api/saved/status") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await updateSavedStatus(payload.run_id || "", payload.status || ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (
    (request.method === "DELETE" && savedRoute?.length === 2)
    || (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "delete")
  ) {
    try {
      sendJson(response, await deleteSavedRun(savedRoute[1]));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && route === "/api/saved/delete") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await deleteSavedRun(payload.run_id || ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && route === "/api/saved/uploaded") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await markSavedUploaded(payload.run_id || ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && route === "/api/saved/unuploaded") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await unmarkSavedUploaded(payload.run_id || ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  return false;
}
