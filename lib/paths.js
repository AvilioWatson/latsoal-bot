import path from "node:path";
import {fileURLToPath} from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_ROOT = process.env.LATSOAL_DATA_ROOT
  ? path.resolve(process.env.LATSOAL_DATA_ROOT)
  : ROOT;
export const FRONTEND = path.join(ROOT, "frontend");
export const OUTPUTS = path.join(DATA_ROOT, "outputs");
export const SAVED = path.join(DATA_ROOT, "saved");
export const APPROVED = path.join(DATA_ROOT, "approved");

export const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
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

export function buildWebFiles(routeBase, runId, files = {}) {
  const artifactName = (file) => String(file).split(/[\\/]/).pop();
  const webFiles = {
    question: `${routeBase}/${runId}/soal.json`,
    caption: `${routeBase}/${runId}/caption.txt`,
    metadata: `${routeBase}/${runId}/metadata.json`,
  };
  if (Array.isArray(files.images) && files.images.length > 0) {
    webFiles.images = files.images.map((file) => `${routeBase}/${runId}/${artifactName(file)}`);
    webFiles.image = webFiles.images[0];
  } else if (files.image) {
    webFiles.image = `${routeBase}/${runId}/${artifactName(files.image)}`;
    webFiles.images = [webFiles.image];
  }
  if (files.explanation) {
    webFiles.explanation = `${routeBase}/${runId}/${artifactName(files.explanation)}`;
  }
  if (Array.isArray(files.explanations) && files.explanations.length > 0) {
    webFiles.explanations = files.explanations.map((file) => `${routeBase}/${runId}/${artifactName(file)}`);
  }
  return webFiles;
}

export function isValidRunId(runId) {
  return /^\d{8}-\d{6}$/.test(runId);
}
