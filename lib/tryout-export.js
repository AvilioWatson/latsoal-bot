import {canonicalTopic, subtestCode} from "./paths.js";
import {artifactName} from "./route-utils.js";

export const TRYOUT_EXPORT_SCHEMA_VERSION = "tryout-export.v1";
export const TRYOUT_EXPORT_FILENAME = `${TRYOUT_EXPORT_SCHEMA_VERSION}.json`;
export const CHOICE_KEYS = ["A", "B", "C", "D", "E"];

function normalizeDifficulty(level) {
  const value = String(level || "").trim().toLowerCase();
  if (value === "mudah") return "easy";
  if (value === "sedang") return "medium";
  if (value === "sulit") return "hard";
  return "medium";
}

function buildTryoutAssets(metadata, exportId, runId) {
  const files = metadata?.files || {};
  const assetUrl = (file) => `/approved/${exportId}/${runId}/${artifactName(file)}`;
  const assets = {
    images: [],
    explanations: [],
  };

  if (Array.isArray(files.images)) {
    assets.images = files.images.filter(Boolean).map(assetUrl);
  } else if (files.image) {
    assets.images = [assetUrl(files.image)];
  }
  if (files.thumbnail) assets.thumbnail = assetUrl(files.thumbnail);
  if (files.image) assets.image = assetUrl(files.image);
  if (files.explanation) assets.explanation = assetUrl(files.explanation);
  if (Array.isArray(files.explanations)) {
    assets.explanations = files.explanations.filter(Boolean).map(assetUrl);
  }

  return assets;
}

export function tryoutQuestionWarnings(metadata, question = metadata?.question || {}) {
  const warnings = [];
  if (metadata?.review_status !== "ready") {
    warnings.push({
      code: "review_not_ready",
      message: "Soal approved tetapi review_status belum ready.",
    });
  }
  if (!question?.soal) {
    warnings.push({code: "missing_question_text", message: "Teks soal kosong."});
  }
  if (!question?.pembahasan) {
    warnings.push({code: "missing_explanation", message: "Pembahasan kosong."});
  }
  if (!CHOICE_KEYS.includes(question?.jawaban)) {
    warnings.push({code: "invalid_correct_answer", message: "Jawaban benar bukan A-E."});
  }
  for (const key of CHOICE_KEYS) {
    if (!question?.pilihan?.[key]) {
      warnings.push({code: "missing_option", message: `Pilihan ${key} kosong.`});
    }
  }
  return warnings;
}

export function metadataToTryoutQuestion(runId, metadata, exportId) {
  const question = metadata?.question || {};
  const passage = question.bacaan && typeof question.bacaan === "object" ? question.bacaan : null;
  const subtestName = question.mapel || null;
  const topic = question.topik || null;
  const warnings = tryoutQuestionWarnings(metadata, question);
  const questionText = passage?.teks
    ? `Bacaan:\n${passage.teks}\n\nSoal ${passage.nomor_soal || ""}/${passage.total_soal || ""}:\n${question.soal || ""}`.trim()
    : question.soal || "";
  return {
    external_id: runId,
    passage_id: passage?.id || null,
    passage_order: passage?.nomor_soal || null,
    passage: passage || null,
    subtest_name: subtestName,
    subtest_code: subtestCode(subtestName),
    topic,
    canonical_topic: canonicalTopic(subtestName, topic),
    difficulty_raw: question.level || null,
    difficulty: normalizeDifficulty(question.level),
    question_text: questionText,
    stem_text: question.soal || "",
    options: CHOICE_KEYS.map((label, index) => ({
      label,
      text: question?.pilihan?.[label] || "",
      sort_order: index + 1,
    })),
    correct_answer: question.jawaban || "",
    explanation: question.pembahasan || "",
    caption: metadata?.caption || null,
    assets: buildTryoutAssets(metadata, exportId, runId),
    source: metadata?.source || null,
    review_status: metadata?.review_status || null,
    validation: metadata?.validation || metadata?.validator || null,
    dedup: metadata?.dedup || null,
    warnings,
  };
}
