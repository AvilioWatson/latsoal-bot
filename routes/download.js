import {readdir, stat} from "node:fs/promises";
import path from "node:path";
import {sendError} from "../lib/http.js";
import {OUTPUTS, SAVED, isValidRunId, safeJoin} from "../lib/paths.js";
import {createZipBuffer} from "../lib/zip.js";

const DOWNLOAD_ROOTS = {
  outputs: OUTPUTS,
  saved: SAVED,
};

function downloadName(scope, runId) {
  return `${scope}-${runId}.zip`;
}

async function buildRunZip(scope, runId) {
  const base = DOWNLOAD_ROOTS[scope];
  if (!base || !isValidRunId(runId)) {
    const error = new Error("Download tidak valid.");
    error.status = 400;
    throw error;
  }

  const runDir = safeJoin(base, runId);
  if (!runDir) {
    const error = new Error("Path download tidak valid.");
    error.status = 400;
    throw error;
  }

  let names;
  try {
    names = await readdir(runDir);
  } catch {
    const error = new Error("Folder run tidak ditemukan.");
    error.status = 404;
    throw error;
  }

  const preferred = new Map(names.map((name) => [name, name]));
  const orderedNames = [
    "metadata.json",
    "soal.json",
    "caption.txt",
    ...names.filter((name) => /^post-\d+\.png$/i.test(name)).sort(),
    ...names.filter((name) => /^pembahasan-\d+\.jpe?g$/i.test(name)).sort(),
    ...names.filter((name) => !/^(metadata\.json|soal\.json|caption\.txt|post-\d+\.png|pembahasan-\d+\.jpe?g)$/i.test(name)).sort(),
  ].filter((name, index, list) => preferred.has(name) && list.indexOf(name) === index);

  const entries = [];
  for (const name of orderedNames) {
    const target = safeJoin(runDir, name);
    if (!target) continue;
    const info = await stat(target);
    if (!info.isFile()) continue;
    entries.push({
      name: `${runId}/${path.basename(name)}`,
      path: target,
      date: info.mtime,
    });
  }

  if (entries.length === 0) {
    const error = new Error("Folder run kosong.");
    error.status = 404;
    throw error;
  }

  return createZipBuffer(entries);
}

export async function handle(request, response, route) {
  if (request.method !== "GET") return false;

  const match = route.match(/^\/download\/(outputs|saved)\/(\d{8}-\d{6})$/);
  if (!match) return false;

  try {
    const [, scope, runId] = match;
    const body = await buildRunZip(scope, runId);
    response.writeHead(200, {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Content-Type": "application/zip",
      "Content-Length": body.length,
      "Content-Disposition": `attachment; filename="${downloadName(scope, runId)}"`,
    });
    response.end(body);
  } catch (error) {
    sendError(response, error.status || 500, error.message);
  }
  return true;
}
