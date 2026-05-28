import path from "node:path";
import {fileURLToPath} from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FRONTEND = path.join(ROOT, "frontend");
export const OUTPUTS = path.join(ROOT, "outputs");
export const SAVED = path.join(ROOT, "saved");
export const APPROVED = path.join(ROOT, "approved");

export const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function safeJoin(base, requestPath) {
  const target = path.resolve(base, requestPath);
  const baseResolved = path.resolve(base);
  if (target !== baseResolved && !target.startsWith(baseResolved + path.sep)) {
    return null;
  }
  return target;
}

export function buildWebFiles(routeBase, runId) {
  return {
    question: `${routeBase}/${runId}/soal.json`,
    caption: `${routeBase}/${runId}/caption.txt`,
    metadata: `${routeBase}/${runId}/metadata.json`,
  };
}

export function isValidRunId(runId) {
  return /^\d{8}-\d{6}$/.test(runId);
}
