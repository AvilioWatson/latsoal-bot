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
    },
    {
      run_id: "20260529-110000",
      subtes: "penalaran-umum",
      level: "sedang",
      status: "approved",
      source: "fallback",
      saved_at: "2026-05-29T11:00:00.000Z",
      is_duplicate: true,
    },
    {
      run_id: "20260520-110000",
      subtes: "literasi-bahasa-inggris",
      level: "sulit",
      status: "rejected",
      source: "draft",
      saved_at: "2026-05-20T11:00:00.000Z",
    },
  ], NOW);

  assert.equal(stats.total, 3);
  assert.deepEqual(stats.by_status, {saved: 0, approved: 2, rejected: 1});
  assert.equal(stats.by_subtes["penalaran-umum"].approved, 2);
  assert.equal(stats.by_source.fallback, 1);
  assert.equal(stats.by_level.sulit, 1);
  assert.equal(stats.last_7_days.total_generated, 2);
  assert.equal(stats.last_7_days.fallback_rate, 0.5);
  assert.equal(stats.duplicate_rate, 0.3333);
  assert.equal(stats.export_batches, 1);
  assert.equal(stats.last_exported_at, "2026-05-29T10:00:00.000Z");
  assert.equal(stats.pending_export, 1);
});

test("buildStats treats unknown status as saved and handles empty input", () => {
  assert.equal(buildStats([], NOW).total, 0);

  const stats = buildStats([{status: "published", saved_at: "2026-05-29T00:00:00.000Z"}], NOW);
  assert.equal(stats.by_status.saved, 1);
  assert.equal(stats.by_subtes.unknown.saved, 1);
});
