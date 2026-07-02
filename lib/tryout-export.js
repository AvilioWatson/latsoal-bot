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

function questionGroupItems(question = {}) {
  const group = Array.isArray(question.question_group) ? question.question_group : [];
  if (!group.length) return [question];
  return group.map((item, index) => ({
    ...question,
    soal: item.soal || "",
    pilihan: item.pilihan || {},
    jawaban: item.jawaban || "",
    pembahasan: item.pembahasan || "",
    konsep_kunci: item.konsep_kunci || question.konsep_kunci || "",
    tips_pengerjaan: item.tips_pengerjaan || question.tips_pengerjaan || "",
    butuh_visual: Boolean(item.butuh_visual),
    deskripsi_visual: item.deskripsi_visual || "",
    bacaan: question.bacaan
      ? {...question.bacaan, nomor_soal: Number(item.nomor_soal || index + 1), total_soal: Number(question.group_total_soal || question.bacaan.total_soal || group.length)}
      : question.bacaan,
  }));
}

export function metadataToTryoutQuestion(runId, metadata, exportId) {
  return metadataToTryoutQuestions(runId, metadata, exportId)[0];
}

export function metadataToTryoutQuestions(runId, metadata, exportId) {
  const question = metadata?.question || {};
  const passage = question.bacaan && typeof question.bacaan === "object" ? question.bacaan : null;
  const subtestName = question.mapel || null;
  const topic = question.topik || null;
  const assets = buildTryoutAssets(metadata, exportId, runId);
  return questionGroupItems(question).map((groupedQuestion) => {
    const groupedPassage = groupedQuestion.bacaan && typeof groupedQuestion.bacaan === "object" ? groupedQuestion.bacaan : passage;
    const warnings = tryoutQuestionWarnings(metadata, groupedQuestion);
    const groupedTotal = Number(groupedPassage?.total_soal || 0);
    const questionText = groupedPassage?.teks
      ? groupedTotal <= 1
        ? `${groupedPassage.judul ? `${groupedPassage.judul}\n\n` : ""}${groupedPassage.teks}\n\n${groupedQuestion.soal || ""}`.trim()
        : `Bacaan:\n${groupedPassage.teks}\n\nSoal ${groupedPassage.nomor_soal || ""}/${groupedPassage.total_soal || ""}:\n${groupedQuestion.soal || ""}`.trim()
      : groupedQuestion.soal || "";
    const suffix = groupedPassage?.nomor_soal ? `-${groupedPassage.nomor_soal}` : "";
    return {
      external_id: `${runId}${suffix}`,
      source_run_id: runId,
      passage_id: groupedPassage?.id || null,
      passage_order: groupedPassage?.nomor_soal || null,
      passage: groupedPassage || null,
      subtest_name: subtestName,
      subtest_code: subtestCode(subtestName),
      topic,
      canonical_topic: canonicalTopic(subtestName, topic),
      difficulty_raw: question.level || null,
      difficulty: normalizeDifficulty(question.level),
      question_text: questionText,
      stem_text: groupedQuestion.soal || "",
      options: CHOICE_KEYS.map((label, index) => ({
        label,
        text: groupedQuestion?.pilihan?.[label] || "",
        sort_order: index + 1,
      })),
      correct_answer: groupedQuestion.jawaban || "",
      explanation: groupedQuestion.pembahasan || "",
      caption: metadata?.caption || null,
      assets,
      source: metadata?.source || null,
      review_status: metadata?.review_status || null,
      validation: metadata?.validation || metadata?.validator || null,
      dedup: metadata?.dedup || null,
      warnings,
    };
  });
}
