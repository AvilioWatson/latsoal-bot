import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {
  autoTokenPlan,
  normalizeAutoGeneratePayload,
} from "../services/generate-service.js";

test("auto generator accepts only supported batch sizes and uses subtest without subtopic", () => {
  const payload = normalizeAutoGeneratePayload({
    mapel: "Penalaran Umum",
    count: 10,
    level: "sedang",
    mode: "draft",
    provider: "gemini",
    account: "@latsoal",
  });

  assert.equal(payload.mapel, "Penalaran Umum");
  assert.equal(payload.count, 10);
  assert.equal(payload.level, "sedang");
  assert.equal(payload.mode, "draft");
  assert.equal(payload.provider, "gemini");
  assert.equal(payload.account, "@latsoal");
  assert.equal(Object.hasOwn(payload, "topik"), false);
});

test("auto generator rejects unsupported batch sizes", () => {
  assert.throws(
    () => normalizeAutoGeneratePayload({mapel: "Penalaran Umum", count: 12}),
    /Jumlah auto generator harus 5, 10, atau 15 soal/,
  );
});

test("auto token plan does not pre-cut batches from static estimates", () => {
  const plan = autoTokenPlan(15, {
    token_budget: 72000,
    estimated_tokens_per_question: 6000,
  });

  assert.equal(plan.plannedCount, 15);
  assert.equal(plan.tokenLimited, false);
  assert.equal(plan.tokenBudget, 72000);
  assert.equal(plan.preflightLimited, false);
});

test("generator page exposes the auto generator controls and endpoint", async () => {
  const html = await readFile("frontend/index.html", "utf-8");
  const script = await readFile("frontend/app.js", "utf-8");

  assert.match(html, /id="autoGenerateButton"/);
  assert.match(html, /id="batchResults"/);
  assert.match(html, /id="batchResultList"/);
  assert.match(html, /id="saveAllBatchButton"/);
  assert.match(html, /id="resetCacheButton"/);
  assert.match(html, /name="auto_count" value="5"/);
  assert.match(html, /name="auto_count" value="10"/);
  assert.match(html, /name="auto_count" value="15"/);
  assert.match(script, /\/generate\/auto/);
  assert.match(script, /delete payload\.topik/);
  assert.match(script, /function renderBatchList/);
  assert.match(script, /data\.results \|\| \[\]/);
  assert.match(script, /function saveAllBatchResults/);
  assert.match(script, /saveAllBatchButton\?\.addEventListener\("click", saveAllBatchResults\)/);
  assert.match(script, /function resetGeneratorCache/);
  assert.match(script, /resetCacheButton\?\.addEventListener\("click", resetGeneratorCache\)/);
  assert.match(script, /\/api\/generator\/cache/);
  assert.match(script, /BATCH_STORAGE_KEY/);
  assert.match(script, /localStorage\.setItem/);
  assert.match(script, /restoreBatchState\(\)/);
  assert.match(script, /function similarityText/);
  assert.match(script, /Similarity/);
});
