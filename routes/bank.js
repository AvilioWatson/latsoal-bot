import {access, cp, mkdir, readFile, rm} from "node:fs/promises";
import path from "node:path";
import {
  addEntry,
  createEntryFromMetadata,
  readIndex,
  removeEntry,
  updateEntry,
} from "../lib/filestore.js";
import {errorStatus, readJsonBody, sendError, sendJson} from "../lib/http.js";
import {OUTPUTS, SAVED, buildWebFiles, isValidRunId, safeJoin} from "../lib/paths.js";

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function saveRun(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }

  const source = safeJoin(OUTPUTS, runId);
  const target = safeJoin(SAVED, runId);
  if (!source || !target) {
    throw requestError(400, "Path run tidak valid.");
  }

  try {
    await access(path.join(source, "metadata.json"));
  } catch {
    throw requestError(404, "Output run tidak ditemukan.");
  }
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
    web_files: buildWebFiles("/saved", runId, metadata.files),
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
      web_files: buildWebFiles("/saved", item.run_id, metadata?.files),
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

  const target = safeJoin(SAVED, runId);
  if (!target) {
    throw requestError(400, "Path run tidak valid.");
  }
  try {
    await access(path.join(target, "metadata.json"));
  } catch {
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

async function deleteSavedRun(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }

  const target = safeJoin(SAVED, runId);
  if (!target) {
    throw requestError(400, "Path run tidak valid.");
  }

  await removeEntry(runId);
  await rm(target, {recursive: true, force: true});

  return {
    run_id: runId,
    deleted: true,
  };
}

async function sendSavedMetadata(response, runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  const runDir = path.join(SAVED, runId);
  let metadata;
  try {
    metadata = JSON.parse(await readFile(path.join(runDir, "metadata.json"), "utf-8"));
  } catch {
    throw requestError(404, "Saved run tidak ditemukan.");
  }
  metadata.web_files = buildWebFiles("/saved", runId, metadata.files);
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

  return false;
}
