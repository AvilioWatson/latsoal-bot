import assert from "node:assert/strict";
import test from "node:test";
import {buildStats} from "../routes/stats.js";

const NOW = new Date("2026-05-29T12:00:00.000Z");

test("buildStats aggregates status, source, level, subtest, duplicate, and export metrics", () => {
  const stats = buildStats([
    {
      run_id: "20260529-100000",
      subtes: "penalaran-umum",
      level: "mudah",
      status: "approved",
      source: "gemini",
      saved_at: "2026-05-28T12:00:00.000Z",
      exported_at: "2026-05-29T10:00:00.000Z",
      export_batch_id: "batch-1",
      topik: "penalaran-deduktif",
      uploaded_at: "2026-05-29T11:30:00.000Z",
      token_usage: {
        question: {
          gemini: {prompt_tokens: 10, output_tokens: 20, total_tokens: 30},
          kimi: {prompt_tokens: 0, output_tokens: 0, total_tokens: 0},
        },
        explanation: {
          gemini: {prompt_tokens: 3, output_tokens: 4, total_tokens: 7},
          kimi: {prompt_tokens: 0, output_tokens: 0, total_tokens: 0},
        },
      },
    },
    {
      run_id: "20260529-110000",
      subtes: "penalaran-umum",
      topik: "penalaran-induktif",
      level: "sedang",
      status: "approved",
      source: "fallback",
      saved_at: "2026-05-29T11:00:00.000Z",
      is_duplicate: true,
      token_usage: {
        question: {
          gemini: {prompt_tokens: 0, output_tokens: 0, total_tokens: 0},
          kimi: {prompt_tokens: 5, output_tokens: 6, total_tokens: 11},
        },
        explanation: {
          gemini: {prompt_tokens: 0, output_tokens: 0, total_tokens: 0},
          kimi: {prompt_tokens: 2, output_tokens: 8, total_tokens: 10},
        },
      },
    },
    {
      run_id: "20260520-110000",
      subtes: "literasi-bahasa-inggris",
      topik: "main-idea",
      level: "sulit",
      status: "rejected",
      source: "draft",
      saved_at: "2026-05-20T11:00:00.000Z",
    },
  ], NOW);

  assert.equal(stats.total, 3);
  assert.deepEqual(stats.by_status, {generated: 0, saved: 0, approved: 2, rejected: 1});
  assert.equal(stats.by_subtes["penalaran-umum"].approved, 2);
  assert.equal(stats.by_subtes["penalaran-umum"].uploaded, 1);
  assert.equal(stats.by_subtes["penalaran-umum"].topics["penalaran-deduktif"].total, 1);
  assert.equal(stats.by_subtes["penalaran-umum"].topics["penalaran-deduktif"].uploaded, 1);
  assert.equal(stats.by_subtes["penalaran-umum"].topics["penalaran-induktif"].approved, 1);
  assert.equal(stats.by_source.fallback, 1);
  assert.equal(stats.by_level.sulit, 1);
  assert.equal(stats.last_7_days.total_generated, 2);
  assert.equal(stats.last_7_days.fallback_rate, 0.5);
  assert.equal(stats.duplicate_rate, 0.3333);
  assert.equal(stats.export_batches, 1);
  assert.equal(stats.last_exported_at, "2026-05-29T10:00:00.000Z");
  assert.equal(stats.pending_export, 1);
  assert.equal(stats.token_usage.question.gemini.total_tokens, 30);
  assert.equal(stats.token_usage.question.kimi.total_tokens, 11);
  assert.equal(stats.token_usage.explanation.gemini.total_tokens, 7);
  assert.equal(stats.token_usage.explanation.kimi.total_tokens, 10);
});

test("buildStats treats unknown status as saved and handles empty input", () => {
  assert.equal(buildStats([], NOW).total, 0);

  const stats = buildStats([{status: "published", saved_at: "2026-05-29T00:00:00.000Z"}], NOW);
  assert.equal(stats.by_status.saved, 1);
  assert.equal(stats.by_subtes.unknown.saved, 1);
});

test("buildStats counts grouped question entries by question_count", () => {
  const stats = buildStats([
    {
      status: "approved",
      source: "import",
      subtes: "pengetahuan-dan-pemahaman-umum",
      topik: "kalimat-efektif",
      level: "sedang",
      saved_at: "2026-05-29T00:00:00.000Z",
      question_count: 4,
    },
  ], NOW);

  assert.equal(stats.total, 4);
  assert.equal(stats.by_status.approved, 4);
  assert.equal(stats.by_source.import, 4);
  assert.equal(stats.by_level.sedang, 4);
  assert.equal(stats.by_subtes["pengetahuan-dan-pemahaman-umum"].topics["kalimat-efektif"].total, 4);
  assert.equal(stats.last_7_days.total_generated, 4);
});

test("buildStats includes generated output entries in token totals", () => {
  const stats = buildStats([
    {
      run_id: "20260529-120000",
      status: "generated",
      source: "gemini",
      subtes: "pengetahuan-kuantitatif",
      topik: "statistika-dan-peluang",
      level: "sedang",
      saved_at: "2026-05-29T12:00:00.000Z",
      token_usage: {
        question: {
          gemini: {prompt_tokens: 100, output_tokens: 50, total_tokens: 150},
        },
      },
    },
  ], NOW);

  assert.equal(stats.by_status.generated, 1);
  assert.equal(stats.token_usage.question.gemini.total_tokens, 150);
  assert.equal(stats.last_7_days.total_generated, 1);
});
