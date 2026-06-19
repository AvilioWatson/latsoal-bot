import {access, mkdir, readdir, readFile, rename, writeFile} from "node:fs/promises";
import path from "node:path";
import {compatibleMapel, reportSchemaWarnings, validateBankIndex, validateMetadata} from "./dbschema.js";
import {DATA_ROOT} from "./paths.js";
import {buildStoragePath, canonicalTopic, slugify} from "./paths.js";

const BANK = path.join(DATA_ROOT, "bank");
const SAVED = path.join(DATA_ROOT, "saved");
const INDEX_PATH = path.join(BANK, "index.json");
const TMP_PATH = path.join(BANK, "index.tmp");

let cache = null;
let writeQueue = Promise.resolve();

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
  const compatibleQuestion = {...question, mapel: compatibleMapel(question.mapel)};
  const status = savedItem.status || "saved";
  const itemPath = savedItem.path || metadata?.storage_path && `saved/${metadata.storage_path}` || `saved/${buildStoragePath(compatibleQuestion, runId)}`;
  return {
    run_id: runId,
    subtes: slugify(compatibleQuestion.mapel),
    topik: slugify(canonicalTopic(compatibleQuestion.mapel, question.topik)),
    level: question.level || null,
    status,
    source: metadata?.source || null,
    is_duplicate: Boolean(metadata?.dedup?.is_duplicate),
    saved_at: savedItem.saved_at || metadata?.created_at || null,
    status_updated_at: savedItem.status_updated_at || null,
    approved_at: status === "approved" ? (savedItem.approved_at || savedItem.status_updated_at || null) : null,
    rejected_at: status === "rejected" ? (savedItem.rejected_at || savedItem.status_updated_at || null) : null,
    exported_at: savedItem.exported_at || null,
    export_batch_id: savedItem.export_batch_id || null,
    uploaded_at: savedItem.uploaded_at || null,
    path: itemPath,
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

async function currentBankIndex() {
  try {
    const data = JSON.parse(await readFile(INDEX_PATH, "utf-8"));
    reportSchemaWarnings("bankIndex", validateBankIndex(data, INDEX_PATH));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function withIndexWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

async function rebuildIndexUnlocked() {
  await mkdir(BANK, {recursive: true});
  await mkdir(SAVED, {recursive: true});

  const legacy = await legacySavedIndex();
  const current = await currentBankIndex();
  const legacyByRunId = new Map(legacy.map((item) => [item.run_id, item]));
  const currentByRunId = new Map(current.map((item) => [item.run_id, item]));
  const metadataFiles = [];
  async function collectMetadataFiles(dir) {
    const names = await readdir(dir, {withFileTypes: true});
    for (const dirent of names) {
      const target = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await collectMetadataFiles(target);
      } else if (dirent.isFile() && dirent.name === "metadata.json") {
        metadataFiles.push(target);
      }
    }
  }
  await collectMetadataFiles(SAVED);
  const entries = [];

  for (const metadataPath of metadataFiles) {
    const runId = path.basename(path.dirname(metadataPath));
    if (!/^\d{8}-\d{6}$/.test(runId)) continue;
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
      reportSchemaWarnings("metadata", validateMetadata(metadata, metadataPath));
      const relativeDir = path.relative(DATA_ROOT, path.dirname(metadataPath)).replace(/\\/g, "/");
      entries.push(entryFromMetadata(runId, metadata, {
        ...(legacyByRunId.get(runId) || {}),
        ...(currentByRunId.get(runId) || {}),
        path: relativeDir,
      }));
    } catch {
      continue;
    }
  }

  entries.sort((a, b) => String(b.saved_at || "").localeCompare(String(a.saved_at || "")));
  await writeIndexUnlocked(entries);
  return entries;
}

export async function rebuildIndex() {
  return withIndexWrite(rebuildIndexUnlocked);
}

export async function readIndex() {
  if (cache) return cache;
  await mkdir(BANK, {recursive: true});
  if (!(await exists(INDEX_PATH))) {
    return rebuildIndexUnlocked();
  }
  try {
    const data = JSON.parse(await readFile(INDEX_PATH, "utf-8"));
    reportSchemaWarnings("bankIndex", validateBankIndex(data, INDEX_PATH));
    cache = Array.isArray(data) ? data : [];
    return cache;
  } catch {
    return rebuildIndexUnlocked();
  }
}

async function writeIndexUnlocked(entries) {
  await mkdir(BANK, {recursive: true});
  const normalized = Array.isArray(entries) ? entries : [];
  reportSchemaWarnings("bankIndex", validateBankIndex(normalized, INDEX_PATH));
  await writeFile(TMP_PATH, JSON.stringify(normalized, null, 2), "utf-8");
  await rename(TMP_PATH, INDEX_PATH);
  cache = normalized;
  return cache;
}

export async function addEntry(entry) {
  return withIndexWrite(async () => {
    const entries = await readIndex();
    const next = [
      entry,
      ...entries.filter((item) => item.run_id !== entry.run_id),
    ];
    return writeIndexUnlocked(next);
  });
}

export async function updateEntry(runId, patch) {
  return withIndexWrite(async () => {
    const entries = await readIndex();
    const next = entries.map((item) => (
      item.run_id === runId ? {...item, ...patch} : item
    ));
    await writeIndexUnlocked(next);
    return next.find((item) => item.run_id === runId) || null;
  });
}

export async function removeEntry(runId) {
  return withIndexWrite(async () => {
    const entries = await readIndex();
    const next = entries.filter((item) => item.run_id !== runId);
    await writeIndexUnlocked(next);
    return next;
  });
}

export async function filterEntries(predicate) {
  const entries = await readIndex();
  return entries.filter(predicate);
}

export function createEntryFromMetadata(runId, metadata, patch = {}) {
  const question = metadata?.question || {};
  const compatibleQuestion = {...question, mapel: compatibleMapel(question.mapel)};
  return {
    ...entryFromMetadata(runId, metadata, patch),
    ...patch,
    run_id: runId,
    path: patch.path || `saved/${metadata?.storage_path || buildStoragePath(compatibleQuestion, runId)}`,
  };
}

export async function writeIndex(entries) {
  return withIndexWrite(() => writeIndexUnlocked(entries));
}
