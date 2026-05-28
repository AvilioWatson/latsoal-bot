import {access, mkdir, readdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BANK = path.join(ROOT, "bank");
const SAVED = path.join(ROOT, "saved");
const INDEX_PATH = path.join(BANK, "index.json");
const TMP_PATH = path.join(BANK, "index.tmp");

let cache = null;

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function entryFromMetadata(runId, metadata, savedItem = {}) {
  const question = metadata?.question || {};
  const status = savedItem.status || "saved";
  return {
    run_id: runId,
    subtes: slugify(question.mapel),
    topik: slugify(question.topik),
    level: question.level || null,
    status,
    source: metadata?.source || null,
    is_duplicate: Boolean(metadata?.dedup?.is_duplicate),
    saved_at: savedItem.saved_at || metadata?.created_at || null,
    approved_at: status === "approved" ? (savedItem.status_updated_at || null) : null,
    rejected_at: status === "rejected" ? (savedItem.status_updated_at || null) : null,
    exported_at: savedItem.exported_at || null,
    export_batch_id: savedItem.export_batch_id || null,
    path: `saved/${runId}`,
  };
}

async function legacySavedIndex() {
  try {
    const data = JSON.parse(await readFile(path.join(SAVED, "index.json"), "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function rebuildIndex() {
  await mkdir(BANK, {recursive: true});
  await mkdir(SAVED, {recursive: true});

  const legacy = await legacySavedIndex();
  const legacyByRunId = new Map(legacy.map((item) => [item.run_id, item]));
  const names = await readdir(SAVED, {withFileTypes: true});
  const entries = [];

  for (const dirent of names) {
    if (!dirent.isDirectory()) continue;
    const runId = dirent.name;
    if (!/^\d{8}-\d{6}$/.test(runId)) continue;
    const metadataPath = path.join(SAVED, runId, "metadata.json");
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
      entries.push(entryFromMetadata(runId, metadata, legacyByRunId.get(runId) || {}));
    } catch {
      continue;
    }
  }

  entries.sort((a, b) => String(b.saved_at || "").localeCompare(String(a.saved_at || "")));
  await writeIndex(entries);
  return entries;
}

export async function readIndex() {
  if (cache) return cache;
  await mkdir(BANK, {recursive: true});
  if (!(await exists(INDEX_PATH))) {
    return rebuildIndex();
  }
  try {
    const data = JSON.parse(await readFile(INDEX_PATH, "utf-8"));
    cache = Array.isArray(data) ? data : [];
    return cache;
  } catch {
    return rebuildIndex();
  }
}

export async function writeIndex(entries) {
  await mkdir(BANK, {recursive: true});
  const normalized = Array.isArray(entries) ? entries : [];
  await writeFile(TMP_PATH, JSON.stringify(normalized, null, 2), "utf-8");
  await rename(TMP_PATH, INDEX_PATH);
  cache = normalized;
  return cache;
}

export async function addEntry(entry) {
  const entries = await readIndex();
  const next = [
    entry,
    ...entries.filter((item) => item.run_id !== entry.run_id),
  ];
  return writeIndex(next);
}

export async function updateEntry(runId, patch) {
  const entries = await readIndex();
  const next = entries.map((item) => (
    item.run_id === runId ? {...item, ...patch} : item
  ));
  await writeIndex(next);
  return next.find((item) => item.run_id === runId) || null;
}

export async function removeEntry(runId) {
  const entries = await readIndex();
  const next = entries.filter((item) => item.run_id !== runId);
  await writeIndex(next);
  return next;
}

export async function filterEntries(predicate) {
  const entries = await readIndex();
  return entries.filter(predicate);
}

export function createEntryFromMetadata(runId, metadata, patch = {}) {
  return {
    ...entryFromMetadata(runId, metadata, patch),
    ...patch,
    run_id: runId,
    path: `saved/${runId}`,
  };
}
