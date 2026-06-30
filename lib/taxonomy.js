import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {requestError} from "./route-utils.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED_TAXONOMY_PATH = path.join(ROOT, "config", "taxonomy.json");

function defaultTaxonomyPath() {
  if (process.env.LATSOAL_TAXONOMY_PATH) {
    return path.resolve(process.env.LATSOAL_TAXONOMY_PATH);
  }
  if (process.env.LATSOAL_DATA_ROOT) {
    const dataRoot = path.resolve(process.env.LATSOAL_DATA_ROOT);
    if (dataRoot !== ROOT) {
      return path.join(dataRoot, "config", "taxonomy.json");
    }
  }
  return SEED_TAXONOMY_PATH;
}

function ensureTaxonomyFile(filePath) {
  if (existsSync(filePath)) return;
  mkdirSync(path.dirname(filePath), {recursive: true});
  writeFileSync(filePath, readFileSync(SEED_TAXONOMY_PATH, "utf-8"), "utf-8");
}

export const TAXONOMY_PATH = process.env.LATSOAL_TAXONOMY_PATH
  ? path.resolve(process.env.LATSOAL_TAXONOMY_PATH)
  : defaultTaxonomyPath();
ensureTaxonomyFile(TAXONOMY_PATH);
process.env.LATSOAL_TAXONOMY_PATH = TAXONOMY_PATH;
export const TAXONOMY = JSON.parse(readFileSync(TAXONOMY_PATH, "utf-8"));

function restoreMissingSeedSubtests() {
  const seed = JSON.parse(readFileSync(SEED_TAXONOMY_PATH, "utf-8"));
  let changed = false;
  for (const subtest of Object.keys(seed.topics || {})) {
    if (Object.hasOwn(TAXONOMY.topics || {}, subtest)) continue;
    TAXONOMY.topics = TAXONOMY.topics || {};
    TAXONOMY.topics[subtest] = seed.topics[subtest];
    if (seed.subtest_codes?.[subtest]) {
      TAXONOMY.subtest_codes = TAXONOMY.subtest_codes || {};
      TAXONOMY.subtest_codes[subtest] = seed.subtest_codes[subtest];
    }
    if (seed.topic_aliases?.[subtest]) {
      TAXONOMY.topic_aliases = TAXONOMY.topic_aliases || {};
      TAXONOMY.topic_aliases[subtest] = seed.topic_aliases[subtest];
    }
    if (seed.pattern_files?.[subtest]) {
      TAXONOMY.pattern_files = TAXONOMY.pattern_files || {};
      TAXONOMY.pattern_files[subtest] = seed.pattern_files[subtest];
    }
    changed = true;
  }
  if (changed) {
    writeFileSync(TAXONOMY_PATH, `${JSON.stringify(TAXONOMY, null, 2)}\n`, "utf-8");
  }
}

restoreMissingSeedSubtests();
export const TOPICS = TAXONOMY.topics || {};
export const PATTERN_FILES = TAXONOMY.pattern_files || {};

function canonicalKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTopicName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function deleteOwnKey(object, key) {
  if (object && Object.hasOwn(object, key)) {
    delete object[key];
  }
}

async function persistTaxonomy() {
  await writeFile(TAXONOMY_PATH, `${JSON.stringify(TAXONOMY, null, 2)}\n`, "utf-8");
}

export function configPayload() {
  return {
    topics: TOPICS,
    subtest_codes: TAXONOMY.subtest_codes || {},
    topic_aliases: TAXONOMY.topic_aliases || {},
    pattern_files: PATTERN_FILES,
    taxonomy_path: TAXONOMY_PATH,
  };
}

export async function addTopicToSubtest(payload = {}) {
  const mapel = normalizeTopicName(payload.mapel);
  const topik = normalizeTopicName(payload.topik);

  if (!mapel || !Object.hasOwn(TOPICS, mapel)) {
    throw requestError(400, "Subtes tidak valid.");
  }
  if (!topik) {
    throw requestError(400, "Subtopik wajib diisi.");
  }
  if (topik.length > 80) {
    throw requestError(400, "Subtopik maksimal 80 karakter.");
  }

  const topics = TOPICS[mapel] || [];
  const existing = topics.find((topic) => canonicalKey(topic) === canonicalKey(topik));
  if (existing) {
    return {created: false, mapel, topik: existing, topics, taxonomy_path: TAXONOMY_PATH};
  }

  topics.push(topik);
  TOPICS[mapel] = topics;
  TAXONOMY.topics = TOPICS;
  await persistTaxonomy();

  return {created: true, mapel, topik, topics, taxonomy_path: TAXONOMY_PATH};
}

export async function deleteTopicFromSubtest(payload = {}) {
  const mapel = normalizeTopicName(payload.mapel);
  const topik = normalizeTopicName(payload.topik);

  if (!mapel || !Object.hasOwn(TOPICS, mapel)) {
    throw requestError(400, "Subtes tidak valid.");
  }
  if (!topik) {
    throw requestError(400, "Subtopik wajib diisi.");
  }

  const topics = TOPICS[mapel] || [];
  if (topics.length <= 1) {
    throw requestError(400, "Minimal harus ada satu subtopik untuk subtes ini.");
  }
  const existing = topics.find((topic) => canonicalKey(topic) === canonicalKey(topik));
  if (!existing) {
    throw requestError(400, "Subtopik tidak tersedia untuk subtes terpilih.");
  }

  TOPICS[mapel] = topics.filter((topic) => canonicalKey(topic) !== canonicalKey(existing));
  TAXONOMY.topics = TOPICS;
  for (const [alias, canonical] of Object.entries(TAXONOMY.topic_aliases?.[mapel] || {})) {
    if (canonicalKey(canonical) === canonicalKey(existing)) {
      deleteOwnKey(TAXONOMY.topic_aliases[mapel], alias);
    }
  }
  await persistTaxonomy();

  return {deleted: true, mapel, topik: existing, topics: TOPICS[mapel], taxonomy_path: TAXONOMY_PATH};
}
