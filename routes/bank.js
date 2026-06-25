import {spawn} from "node:child_process";
import {access, cp, mkdir, readdir, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {readJsonValidated, validateQuestion, writeJsonValidated} from "../lib/dbschema.js";
import {normalizeCaptionForStorage, normalizeQuestionForStorage} from "../lib/content-normalize.js";
import {
  addEntry,
  createEntryFromMetadata,
  rebuildIndex,
  readIndex,
  removeEntry,
  updateEntry,
} from "../lib/filestore.js";
import {errorStatus, readJsonBody, sendError, sendJson} from "../lib/http.js";
import {OUTPUTS, ROOT, SAVED, buildStoragePath, buildWebFiles, canonicalTopic, isValidRunId, pathFromIndexEntry, safeJoin} from "../lib/paths.js";
import {requestError, wantsJson} from "../lib/route-utils.js";

const DEFAULT_PYTHON = process.env.PYTHON || "python";

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
  const metadata = await readJsonValidated(path.join(sourceRun.dir, "metadata.json"), "metadata");
  try {
    await readJsonValidated(path.join(sourceRun.dir, "soal.json"), "question");
  } catch (error) {
    console.warn(`[schema:question] ${path.join(sourceRun.dir, "soal.json")}: ${error.message}`);
  }
  if (metadata.question) metadata.question = normalizeQuestionForStorage(metadata.question);
  if (metadata.caption) metadata.caption = normalizeCaptionForStorage(metadata.question || {}, metadata.caption);
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
  await writeJsonValidated(path.join(target, "metadata.json"), metadata, "metadata");
  if (metadata.question) {
    await writeJsonValidated(path.join(target, "soal.json"), metadata.question, "question");
  }
  if (metadata.caption) {
    const captionText = metadata.caption.caption || "";
    const hashtags = Array.isArray(metadata.caption.hashtag) ? metadata.caption.hashtag.join(" ") : "";
    await writeFile(path.join(target, "caption.txt"), `${captionText}\n\n${hashtags}\n`, "utf-8");
  }
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
  const index = await rebuildIndex();
  const items = [];
  for (const item of index) {
    if (!isValidRunId(item.run_id)) continue;
    const artifactPath = pathFromIndexEntry(item, "saved");
    const metadataPath = path.join(SAVED, artifactPath, "metadata.json");
    let metadata = null;
    try {
      metadata = await readJsonValidated(metadataPath, "metadata");
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
      canonical_topik: canonicalTopic(metadata?.question?.mapel, metadata?.question?.topik) || null,
      explanation_review: metadata?.explanation_review || null,
      level: metadata?.question?.level || null,
      soal_excerpt: String(metadata?.question?.soal || "").replace(/\s+/g, " ").trim().slice(0, 180),
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

function runExplanationReview(metadataPath, provider = "gemini") {
  return new Promise((resolve, reject) => {
    const child = spawn(DEFAULT_PYTHON, [
      "content_generator.py",
      "--review-explanation",
      metadataPath,
      "--provider",
      provider,
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
        reject(new Error(stderr || "Review pembahasan tidak mengembalikan JSON valid."));
        return;
      }
      if (code !== 0 || parsed.ok === false) {
        reject(new Error(parsed.detail || stderr || "Review pembahasan gagal."));
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

async function reviewSavedExplanation(runId, provider = "gemini") {
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
    metadata = await readJsonValidated(metadataPath, "metadata");
  } catch {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const result = await runExplanationReview(metadataPath, provider);
  return {
    run_id: runId,
    explanation_review: result.explanation_review,
    web_files: buildWebFiles("/saved", artifactPath, metadata.files),
  };
}

async function applySavedExplanationReview(runId, payload) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  const revisedQuestion = payload?.question_revisi;
  const review = payload?.explanation_review;
  if (!revisedQuestion || typeof revisedQuestion !== "object" || Array.isArray(revisedQuestion)) {
    throw requestError(400, "Draft revisi soal tidak valid.");
  }
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    throw requestError(400, "Hasil review tidak valid.");
  }
  if (typeof review.lolos !== "boolean") {
    throw requestError(400, "Status lolos pada hasil review tidak valid.");
  }
  const warnings = validateQuestion(revisedQuestion, "question_revisi");
  if (warnings.length) {
    throw requestError(400, `Draft revisi belum valid: ${warnings[0].path} ${warnings[0].message}`);
  }

  const resolved = await resolveSavedRun(runId);
  const runDir = resolved?.dir;
  const artifactPath = resolved?.artifactPath || runId;
  if (!runDir) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }
  const metadataPath = path.join(runDir, "metadata.json");
  const metadata = await readJsonValidated(metadataPath, "metadata");
  const {question_revisi: _ignoredQuestion, ...reviewSummary} = review;
  const now = new Date().toISOString();
  metadata.question = normalizeQuestionForStorage(revisedQuestion);
  if (metadata.caption) metadata.caption = normalizeCaptionForStorage(metadata.question, metadata.caption);
  metadata.explanation_review = {
    ...reviewSummary,
    pembahasan_revisi: metadata.question.pembahasan,
    applied_at: now,
  };
  metadata.review_status = reviewSummary.lolos ? "ready" : "needs_review";
  metadata.edited_at = now;
  await writeJsonValidated(metadataPath, metadata, "metadata");
  await writeJsonValidated(path.join(runDir, "soal.json"), metadata.question, "question");

  const patchedEntry = createEntryFromMetadata(runId, metadata, {
    ...(resolved.entry || {}),
    path: `saved/${artifactPath}`,
    status: "saved",
    status_updated_at: now,
    approved_at: null,
    rejected_at: null,
  });
  await updateEntry(runId, patchedEntry);
  return {
    ok: true,
    run_id: runId,
    question: metadata.question,
    explanation_review: metadata.explanation_review,
    review_status: metadata.review_status,
    web_files: buildWebFiles("/saved", artifactPath, metadata.files),
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
    metadata = await readJsonValidated(metadataPath, "metadata");
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
  await writeJsonValidated(metadataPath, metadata, "metadata");

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
    metadata = await readJsonValidated(path.join(runDir, "metadata.json"), "metadata");
  } catch {
    throw requestError(404, "Saved run tidak ditemukan.");
  }
  metadata.web_files = buildWebFiles("/saved", artifactPath, metadata.files);
  if (metadata.question) metadata.canonical_topik = canonicalTopic(metadata.question.mapel, metadata.question.topik);
  sendJson(response, metadata);
}

async function updateSavedMetadataJson(runId, metadata) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw requestError(400, "Metadata harus berupa JSON object.");
  }
  if (metadata.run_id && metadata.run_id !== runId) {
    throw requestError(400, "run_id metadata tidak boleh berbeda dari URL.");
  }

  const resolved = await resolveSavedRun(runId);
  const runDir = resolved?.dir;
  const artifactPath = resolved?.artifactPath || runId;
  if (!runDir) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const nextMetadata = {
    ...metadata,
    run_id: runId,
    storage_path: artifactPath,
    edited_at: new Date().toISOString(),
  };
  if (nextMetadata.question) {
    nextMetadata.question = normalizeQuestionForStorage(nextMetadata.question);
  }
  if (nextMetadata.caption) {
    nextMetadata.caption = normalizeCaptionForStorage(nextMetadata.question || {}, nextMetadata.caption);
  }
  retargetMetadataFiles(nextMetadata, runDir);
  await writeJsonValidated(path.join(runDir, "metadata.json"), nextMetadata, "metadata");
  if (nextMetadata.question) {
    await writeJsonValidated(path.join(runDir, "soal.json"), nextMetadata.question, "question");
  }
  if (nextMetadata.caption) {
    const captionText = nextMetadata.caption.caption || "";
    const hashtags = Array.isArray(nextMetadata.caption.hashtag) ? nextMetadata.caption.hashtag.join(" ") : "";
    await writeFile(path.join(runDir, "caption.txt"), `${captionText}\n\n${hashtags}\n`, "utf-8");
  }

  const patchedEntry = createEntryFromMetadata(runId, nextMetadata, {
    ...(resolved.entry || {}),
    path: `saved/${artifactPath}`,
  });
  await updateEntry(runId, patchedEntry);
  return {
    ok: true,
    run_id: runId,
    metadata: {
      ...nextMetadata,
      web_files: buildWebFiles("/saved", artifactPath, nextMetadata.files),
      canonical_topik: nextMetadata.question
        ? canonicalTopic(nextMetadata.question.mapel, nextMetadata.question.topik)
        : null,
    },
  };
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

  if (request.method === "PUT" && savedRoute?.length === 3 && savedRoute[2] === "json") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await updateSavedMetadataJson(savedRoute[1], payload));
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

  if (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "explanation-review") {
    try {
      const payload = await readJsonBody(request).catch(() => ({}));
      sendJson(response, await reviewSavedExplanation(savedRoute[1], payload.provider || "gemini"));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (
    request.method === "POST"
    && savedRoute?.length === 4
    && savedRoute[2] === "explanation-review"
    && savedRoute[3] === "apply"
  ) {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await applySavedExplanationReview(savedRoute[1], payload));
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
