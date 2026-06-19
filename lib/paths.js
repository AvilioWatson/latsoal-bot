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
  const artifactPath = String(runId || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const artifactName = (file) => String(file).split(/[\\/]/).pop();
  const webFiles = {
    question: `${routeBase}/${artifactPath}/soal.json`,
    caption: `${routeBase}/${artifactPath}/caption.txt`,
    metadata: `${routeBase}/${artifactPath}/metadata.json`,
  };
  if (Array.isArray(files.images) && files.images.length > 0) {
    webFiles.images = files.images.map((file) => `${routeBase}/${artifactPath}/${artifactName(file)}`);
    webFiles.image = webFiles.images[0];
  } else if (files.image) {
    webFiles.image = `${routeBase}/${artifactPath}/${artifactName(files.image)}`;
    webFiles.images = [webFiles.image];
  }
  if (files.thumbnail) {
    webFiles.thumbnail = `${routeBase}/${artifactPath}/${artifactName(files.thumbnail)}`;
  }
  if (files.explanation) {
    webFiles.explanation = `${routeBase}/${artifactPath}/${artifactName(files.explanation)}`;
  }
  if (Array.isArray(files.explanations) && files.explanations.length > 0) {
    webFiles.explanations = files.explanations.map((file) => `${routeBase}/${artifactPath}/${artifactName(file)}`);
  }
  return webFiles;
}

export function isValidRunId(runId) {
  return /^\d{8}-\d{6}$/.test(runId);
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const SUBTEST_CODES = new Map([
  ["pengetahuan-kuantitatif", "PK"],
  ["penalaran-matematika", "PM"],
  ["penalaran-umum", "PU"],
  ["pengetahuan-dan-pemahaman-umum", "PPU"],
  ["pemahaman-bacaan-dan-menulis", "PBM"],
  ["literasi-bahasa-indonesia", "LBI"],
  ["literasi-bahasa-inggris", "LBE"],
]);

const TOPIC_ALIASES = new Map([
  ["pengetahuan-kuantitatif/persamaan-linear", "Aljabar dan Fungsi"],
  ["pengetahuan-kuantitatif/persamaan-kuadrat", "Aljabar dan Fungsi"],
  ["pengetahuan-kuantitatif/fungsi-linear", "Aljabar dan Fungsi"],
  ["pengetahuan-kuantitatif/fungsi-kuadrat", "Aljabar dan Fungsi"],
  ["pengetahuan-kuantitatif/aljabar-linear", "Aljabar dan Fungsi"],
  ["pengetahuan-kuantitatif/sistem-persamaan-linear", "Aljabar dan Fungsi"],
  ["pengetahuan-kuantitatif/pertidaksamaan-linear", "Aljabar dan Fungsi"],
  ["penalaran-matematika/persamaan-linear", "Aljabar dan Fungsi"],
  ["penalaran-matematika/persamaan-kuadrat", "Aljabar dan Fungsi"],
  ["penalaran-matematika/fungsi-linear", "Aljabar dan Fungsi"],
  ["penalaran-matematika/fungsi-kuadrat", "Aljabar dan Fungsi"],
  ["penalaran-matematika/aljabar-linear", "Aljabar dan Fungsi"],
  ["penalaran-matematika/sistem-persamaan-linear", "Aljabar dan Fungsi"],
  ["penalaran-matematika/pertidaksamaan-linear", "Aljabar dan Fungsi"],
]);

export function subtestCode(mapel) {
  const slug = slugify(mapel);
  return SUBTEST_CODES.get(slug) || slug.toUpperCase() || "LAINNYA";
}

export function canonicalTopic(mapel, topic) {
  const rawTopic = topic || "umum";
  return TOPIC_ALIASES.get(`${slugify(mapel)}/${slugify(rawTopic)}`) || rawTopic;
}

export function buildStoragePath(question = {}, runId = "") {
  return [
    subtestCode(question.mapel),
    slugify(canonicalTopic(question.mapel, question.topik)),
    runId,
  ].join("/");
}

export function pathFromIndexEntry(entry, scope = "saved") {
  const raw = String(entry?.path || "");
  const prefix = `${scope}/`;
  if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  return entry?.run_id || "";
}
