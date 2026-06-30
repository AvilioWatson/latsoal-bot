import {readdir, readFile, rm} from "node:fs/promises";
import path from "node:path";
import {readIndex} from "../lib/filestore.js";
import {errorStatus, readJsonBody, sendError, sendJson} from "../lib/http.js";
import {OUTPUTS} from "../lib/paths.js";
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
