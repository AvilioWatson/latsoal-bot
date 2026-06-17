import {readdir, stat} from "node:fs/promises";
import path from "node:path";
import {readIndex} from "../lib/filestore.js";
import {sendError} from "../lib/http.js";
import {OUTPUTS, SAVED, isValidRunId, pathFromIndexEntry, safeJoin} from "../lib/paths.js";
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

  let artifactPath = runId;
  if (scope === "saved") {
    const index = await readIndex();
    const entry = index.find((item) => item.run_id === runId);
    if (entry) artifactPath = pathFromIndexEntry(entry, "saved");
  } else if (scope === "outputs") {
    async function findOutputPath(dir) {
      let names;
      try {
        names = await readdir(dir, {withFileTypes: true});
      } catch {
        return null;
      }
      for (const dirent of names) {
        if (!dirent.isDirectory()) continue;
        const target = path.join(dir, dirent.name);
        if (dirent.name === runId) {
          return path.relative(OUTPUTS, target).replace(/\\/g, "/");
        }
        const nested = await findOutputPath(target);
        if (nested) return nested;
      }
      return null;
    }
    artifactPath = await findOutputPath(OUTPUTS) || runId;
  }
  const runDir = safeJoin(base, artifactPath);
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

  const orderedNames = names
    .filter((name) => /^\d+\.jpe?g$/i.test(name))
    .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));

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
    const error = new Error("Folder run belum memiliki JPG bernomor.");
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
