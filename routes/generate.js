import {readdir, readFile, rm} from "node:fs/promises";
import path from "node:path";
import {readJsonValidated, writeJsonValidated} from "../lib/dbschema.js";
import {readIndex} from "../lib/filestore.js";
import {errorStatus, readJsonBody, sendError, sendJson} from "../lib/http.js";
import {OUTPUTS, SAVED, buildWebFiles, canonicalTopic, isValidRunId, pathFromIndexEntry, safeJoin} from "../lib/paths.js";
import {requestError} from "../lib/route-utils.js";
import {DEDUP_THRESHOLD, checkDuplicateAgainstSaved} from "../lib/similarity.js";
import {TOPICS, addTopicToSubtest, configPayload, deleteTopicFromSubtest} from "../lib/taxonomy.js";
import {generateAutoBatchFromPayload, generateFromPayload} from "../services/generate-service.js";

export {TOPICS};

async function collectOutputMetadata(dir = OUTPUTS, files = []) {
  let entries = [];
  try {
    entries = await readdir(dir, {withFileTypes: true});
  } catch {
    return files;
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectOutputMetadata(target, files);
    } else if (entry.isFile() && entry.name === "metadata.json") {
      files.push(target);
    }
  }
  return files;
}

async function outputCacheItems() {
  const savedRunIds = new Set((await readIndex()).map((item) => item.run_id).filter(Boolean));
  const metadataFiles = await collectOutputMetadata();
  const seenDirs = new Set();
  const items = [];
  for (const metadataPath of metadataFiles) {
    const runDir = path.dirname(metadataPath);
    if (seenDirs.has(runDir)) continue;
    seenDirs.add(runDir);
    const runId = path.basename(runDir);
    let metadata = {};
    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    } catch {
      metadata = {};
    }
    const source = metadata.source || "unknown";
    const fallback = Boolean(metadata.fallback_used || source === "fallback" || metadata.errors?.question || metadata.fallbacks?.length);
    items.push({
      run_id: runId,
      run_dir: runDir,
      source,
      fallback,
      saved: savedRunIds.has(runId),
    });
  }
  return items;
}

function outputCacheSummary(items) {
  const unsaved = items.filter((item) => !item.saved);
  const bySource = {};
  for (const item of unsaved) {
    bySource[item.source] = (bySource[item.source] || 0) + 1;
  }
  return {
    total_outputs: items.length,
    unsaved_total: unsaved.length,
    unsaved_draft: unsaved.filter((item) => item.source === "draft").length,
    unsaved_fallback: unsaved.filter((item) => item.fallback).length,
    unsaved_by_source: bySource,
  };
}

async function resetOutputCache() {
  const items = await outputCacheItems();
  const targets = items.filter((item) => !item.saved);
  const deleted = [];
  for (const item of targets) {
    await rm(item.run_dir, {recursive: true, force: true});
    deleted.push(item.run_id);
  }
  return {
    ok: true,
    ...outputCacheSummary(items),
    deleted_count: deleted.length,
    deleted_run_ids: deleted,
  };
}

async function resolveOutputRun(runId) {
  if (!isValidRunId(runId)) return null;
  const metadataFiles = await collectOutputMetadata();
  for (const metadataPath of metadataFiles) {
    const runDir = path.dirname(metadataPath);
    if (path.basename(runDir) !== runId) continue;
    const artifactPath = path.relative(OUTPUTS, runDir).replace(/\\/g, "/");
    return {dir: runDir, artifactPath};
  }
  return null;
}

async function resolveSavedRun(runId) {
  if (!isValidRunId(runId)) return null;
  const index = await readIndex();
  const entry = index.find((item) => item.run_id === runId);
  const candidates = [];
  if (entry) candidates.push(pathFromIndexEntry(entry, "saved"));
  candidates.push(runId);

  for (const candidate of candidates) {
    const target = safeJoin(SAVED, candidate);
    if (!target) continue;
    try {
      const metadata = await readJsonValidated(path.join(target, "metadata.json"), "metadata");
      return {dir: target, artifactPath: candidate, entry, metadata};
    } catch {
      continue;
    }
  }
  return null;
}

function publicMatchPayload(resolved) {
  if (!resolved?.metadata) return null;
  return {
    run_id: resolved.metadata.run_id || path.basename(resolved.dir),
    source: resolved.metadata.source || "saved",
    review_status: resolved.metadata.review_status || null,
    question: resolved.metadata.question || {},
    caption: resolved.metadata.caption || {},
    validation: resolved.metadata.validation || {},
    dedup: resolved.metadata.dedup || null,
    canonical_topik: resolved.metadata.question
      ? canonicalTopic(resolved.metadata.question.mapel, resolved.metadata.question.topik)
      : null,
    web_files: buildWebFiles("/saved", resolved.artifactPath, resolved.metadata.files),
  };
}

async function recalculateOutputSimilarity(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }

  const resolved = await resolveOutputRun(runId);
  if (!resolved) {
    throw requestError(404, "Output run tidak ditemukan.");
  }

  const metadataPath = path.join(resolved.dir, "metadata.json");
  const metadata = await readJsonValidated(metadataPath, "metadata");
  const {dedup, match} = await checkDuplicateAgainstSaved(metadata.question || {}, {excludeRunId: runId});
  metadata.dedup = dedup;
  await writeJsonValidated(metadataPath, metadata, "metadata");

  let matched = null;
  if (match?.run_id) {
    matched = publicMatchPayload(await resolveSavedRun(match.run_id));
  }

  return {
    ok: true,
    run_id: runId,
    dedup,
    threshold: DEDUP_THRESHOLD,
    match: matched,
  };
}

export async function handle(request, response, route) {
  if (request.method === "GET" && (route === "/api/config" || route === "/config")) {
    sendJson(response, configPayload());
    return true;
  }

  if (request.method === "POST" && (route === "/api/config/topics" || route === "/config/topics")) {
    try {
      const payload = await readJsonBody(request, {limitBytes: 32 * 1024});
      sendJson(response, {
        ok: true,
        ...(await addTopicToSubtest(payload)),
        config: configPayload(),
      });
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "DELETE" && (route === "/api/config/topics" || route === "/config/topics")) {
    try {
      const payload = await readJsonBody(request, {limitBytes: 32 * 1024});
      sendJson(response, {
        ok: true,
        ...(await deleteTopicFromSubtest(payload)),
        config: configPayload(),
      });
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "GET" && (route === "/api/generator/cache" || route === "/generator/cache")) {
    try {
      sendJson(response, {ok: true, ...outputCacheSummary(await outputCacheItems())});
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "DELETE" && (route === "/api/generator/cache" || route === "/generator/cache")) {
    try {
      sendJson(response, await resetOutputCache());
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && (route === "/api/generate" || route === "/generate")) {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await generateFromPayload(payload));
    } catch (error) {
      if (error.payload) {
        sendJson(response, error.payload, 500);
      } else {
        sendError(response, errorStatus(error), error.message);
      }
    }
    return true;
  }

  if (request.method === "POST" && (route === "/api/generate/similarity" || route === "/generate/similarity")) {
    try {
      const payload = await readJsonBody(request, {limitBytes: 32 * 1024});
      sendJson(response, await recalculateOutputSimilarity(payload.run_id || ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && (route === "/api/generate/auto" || route === "/generate/auto")) {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await generateAutoBatchFromPayload(payload));
    } catch (error) {
      if (error.payload) {
        sendJson(response, error.payload, 500);
      } else {
        sendError(response, errorStatus(error), error.message);
      }
    }
    return true;
  }

  return false;
}
