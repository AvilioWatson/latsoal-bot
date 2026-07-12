import path from "node:path";

import {readJsonValidated} from "./dbschema.js";
import {readIndex} from "./filestore.js";
import {SAVED, isValidRunId, pathFromIndexEntry} from "./paths.js";

const STOPWORDS = new Set([
  "yang", "dan", "di", "ke", "dari", "dengan", "untuk", "pada", "adalah",
  "atau", "dalam", "ini", "itu", "sebagai", "maka", "jika", "akan",
  "antara", "berikut", "teks", "kalimat", "soal", "pilihan", "jawaban",
]);

export const DEDUP_THRESHOLD = Number(process.env.DEDUP_THRESHOLD || 0.82);

function checkedAt() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function normalizeTerms(text) {
  const words = String(text || "").toLowerCase().match(/[a-zA-Z0-9]+/g) || [];
  return new Set(words.filter((word) => word.length > 2 && !STOPWORDS.has(word)));
}

export function jaccardSimilarity(left, right) {
  const leftTerms = normalizeTerms(left);
  const rightTerms = normalizeTerms(right);
  if (!leftTerms.size || !rightTerms.size) return 0;

  let intersection = 0;
  for (const term of leftTerms) {
    if (rightTerms.has(term)) intersection += 1;
  }
  const union = new Set([...leftTerms, ...rightTerms]).size;
  return union ? intersection / union : 0;
}

function passageId(question = {}) {
  const passage = question?.bacaan && typeof question.bacaan === "object" ? question.bacaan : null;
  return String(passage?.id || "").trim();
}

function questionText(question = {}) {
  const passage = question?.bacaan && typeof question.bacaan === "object" ? question.bacaan : null;
  const passageKey = [String(passage?.id || ""), String(passage?.nomor_soal || "")].join(" ");
  return [
    question.mapel || "",
    question.topik || "",
    passageKey,
    question.soal || "",
    Object.values(question.pilihan || {}).map((value) => String(value)).join(" "),
  ].join(" ");
}

function passageText(question = {}) {
  const passage = question?.bacaan && typeof question.bacaan === "object" ? question.bacaan : null;
  if (!passage) return "";
  return [
    passage.judul || "",
    passage.teks || "",
  ].join(" ").trim();
}

function isPassageGroup(question = {}) {
  const passage = question?.bacaan && typeof question.bacaan === "object" ? question.bacaan : null;
  if (!passage) return false;
  const total = Number(passage.total_soal || 0);
  return total > 1 || (Array.isArray(question.question_group) && question.question_group.length > 0);
}

function similarityText(question = {}) {
  const text = passageText(question);
  if (isPassageGroup(question) && text) return text;
  return questionText(question);
}

export async function checkDuplicateAgainstSaved(question, {excludeRunId = null} = {}) {
  const currentText = similarityText(question);
  const best = {
    is_duplicate: false,
    similarity: 0,
    matched_run_id: null,
    matched_status: null,
    matched_batch_index: null,
    threshold: DEDUP_THRESHOLD,
    reason: "",
    checked_at: checkedAt(),
    algorithm: "jaccard-v1",
  };
  let match = null;

  const index = await readIndex();
  for (const item of index) {
    const runId = item?.run_id;
    if (!isValidRunId(runId) || runId === excludeRunId) continue;

    const artifactPath = pathFromIndexEntry(item, "saved") || runId;
    const metadataPath = path.join(SAVED, artifactPath, "metadata.json");
    let saved = null;
    try {
      saved = await readJsonValidated(metadataPath, "metadata");
    } catch {
      continue;
    }

    const candidateQuestion = saved?.question || {};
    const similarity = jaccardSimilarity(currentText, similarityText(candidateQuestion));
    if (similarity <= best.similarity) continue;

    best.similarity = Math.round(similarity * 10000) / 10000;
    best.matched_run_id = runId;
    best.matched_status = item?.status || "saved";
    best.matched_batch_index = null;
    match = {
      run_id: runId,
      artifactPath,
      metadata: saved,
    };
  }

  if (best.similarity >= DEDUP_THRESHOLD) {
    best.is_duplicate = true;
    best.reason = "Teks soal terlalu mirip dengan soal yang sudah disimpan.";
  }

  return {dedup: best, match};
}
