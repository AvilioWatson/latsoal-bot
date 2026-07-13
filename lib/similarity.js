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

function normalizeComparableText(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function characterNgrams(text, size = 3) {
  const normalized = normalizeComparableText(text);
  if (!normalized) return new Set();
  if (normalized.length <= size) return new Set([normalized]);
  const grams = new Set();
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size));
  }
  return grams;
}

function diceSimilarity(left, right) {
  const leftGrams = characterNgrams(left);
  const rightGrams = characterNgrams(right);
  if (!leftGrams.size || !rightGrams.size) return 0;
  let intersection = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) intersection += 1;
  }
  return (2 * intersection) / (leftGrams.size + rightGrams.size);
}

export function textSimilarity(left, right) {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  return (jaccardSimilarity(left, right) * 0.65) + (diceSimilarity(left, right) * 0.35);
}

function choicesText(question = {}) {
  return Object.entries(question.pilihan || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(" ");
}

function passageText(question = {}) {
  const passage = question?.bacaan && typeof question.bacaan === "object" ? question.bacaan : null;
  if (!passage) return "";
  return [
    passage.judul || "",
    passage.teks || "",
  ].join(" ").trim();
}

export function questionSimilarity(left = {}, right = {}) {
  const stem = textSimilarity(left.soal, right.soal);
  const leftChoices = choicesText(left);
  const rightChoices = choicesText(right);
  const choices = leftChoices && rightChoices ? textSimilarity(leftChoices, rightChoices) : 0;
  const weighted = leftChoices && rightChoices ? (stem * 0.78) + (choices * 0.22) : stem;
  const similarity = stem >= 0.96 ? Math.max(weighted, stem) : weighted;
  const passage = textSimilarity(passageText(left), passageText(right));
  return {
    similarity,
    stem,
    choices,
    passage,
    samePassage: passage >= 0.98,
  };
}

export async function checkDuplicateAgainstSaved(question, {excludeRunId = null} = {}) {
  const best = {
    is_duplicate: false,
    similarity: 0,
    matched_run_id: null,
    matched_status: null,
    matched_batch_index: null,
    question_similarity: 0,
    passage_similarity: 0,
    same_passage: false,
    similarity_breakdown: {stem: 0, choices: 0},
    threshold: DEDUP_THRESHOLD,
    reason: "",
    checked_at: checkedAt(),
    algorithm: "weighted-question-v2",
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
    const scores = questionSimilarity(question, candidateQuestion);
    if (scores.similarity <= best.similarity) continue;

    best.similarity = Math.round(scores.similarity * 10000) / 10000;
    best.question_similarity = best.similarity;
    best.passage_similarity = Math.round(scores.passage * 10000) / 10000;
    best.same_passage = scores.samePassage;
    best.similarity_breakdown = {
      stem: Math.round(scores.stem * 10000) / 10000,
      choices: Math.round(scores.choices * 10000) / 10000,
    };
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
    best.reason = "Pertanyaan dan pilihan jawaban terlalu mirip dengan soal yang sudah disimpan.";
  }

  return {dedup: best, match};
}
