import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "latsoal-filestore-"));
process.env.LATSOAL_DATA_ROOT = dataRoot;

const {
  addEntry,
  createEntryFromMetadata,
  readIndex,
  rebuildIndex,
  removeEntry,
  updateEntry,
  writeIndex,
} = await import("../lib/filestore.js");
const {
  validateBankIndex,
  validateMetadata,
  validateQuestion,
} = await import("../lib/dbschema.js");

test.after(async () => {
  await rm(dataRoot, {recursive: true, force: true});
});

function metadata(mapel = "Penalaran Umum", topik = "Penalaran deduktif") {
  return {
    created_at: "2026-05-29T10:00:00",
    source: "draft",
    dedup: {is_duplicate: false},
    question: {
      mapel,
      topik,
      level: "mudah",
    },
  };
}

async function writeSavedRun(runId, payload = metadata()) {
  const runDir = path.join(dataRoot, "saved", runId);
  await mkdir(runDir, {recursive: true});
  await writeFile(path.join(runDir, "metadata.json"), JSON.stringify(payload, null, 2), "utf-8");
}

test("rebuildIndex creates entries from saved metadata and legacy status data", async () => {
  const runId = "20990101-010101";
  await writeSavedRun(runId);
  await writeFile(path.join(dataRoot, "saved", "index.json"), JSON.stringify([
    {
      run_id: runId,
      status: "approved",
      saved_at: "2026-05-29T11:00:00.000Z",
      status_updated_at: "2026-05-29T12:00:00.000Z",
    },
  ]), "utf-8");

  const entries = await rebuildIndex();

  assert.equal(entries.length, 1);
  assert.equal(entries[0].run_id, runId);
  assert.equal(entries[0].subtes, "penalaran-umum");
  assert.equal(entries[0].topik, "penalaran-deduktif");
  assert.equal(entries[0].status, "approved");
  assert.equal(entries[0].status_updated_at, "2026-05-29T12:00:00.000Z");
  assert.equal(entries[0].approved_at, "2026-05-29T12:00:00.000Z");
});

test("addEntry replaces an existing run id and keeps newest entry first", async () => {
  await writeIndex([{run_id: "20990101-010101", status: "saved"}]);

  await addEntry({
    run_id: "20990101-010101",
    status: "approved",
    path: "saved/20990101-010101",
  });

  const entries = await readIndex();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "approved");
});

test("updateEntry patches matching entries and returns null for missing run id", async () => {
  await writeIndex([{run_id: "20990101-010101", status: "saved"}]);

  const updated = await updateEntry("20990101-010101", {
    status: "rejected",
    status_updated_at: "2026-05-29T13:00:00.000Z",
  });
  const missing = await updateEntry("20990101-999999", {status: "approved"});

  assert.equal(updated.status, "rejected");
  assert.equal(updated.status_updated_at, "2026-05-29T13:00:00.000Z");
  assert.equal(missing, null);
});

test("removeEntry deletes only the requested run id", async () => {
  await writeIndex([
    {run_id: "20990101-010101", status: "saved"},
    {run_id: "20990101-020202", status: "approved"},
  ]);

  const entries = await removeEntry("20990101-010101");

  assert.deepEqual(entries.map((entry) => entry.run_id), ["20990101-020202"]);
});

test("createEntryFromMetadata preserves review patch fields", () => {
  const entry = createEntryFromMetadata("20990101-030303", metadata(), {
    status: "approved",
    saved_at: "2026-05-29T11:00:00.000Z",
    status_updated_at: "2026-05-29T12:00:00.000Z",
    approved_at: "2026-05-29T12:00:00.000Z",
  });

  assert.equal(entry.status, "approved");
  assert.equal(entry.status_updated_at, "2026-05-29T12:00:00.000Z");
  assert.equal(entry.approved_at, "2026-05-29T12:00:00.000Z");
  assert.equal(entry.path, "saved/PU/penalaran-deduktif/20990101-030303");
});

test("createEntryFromMetadata summarizes AI token usage", () => {
  const payload = {
    ...metadata(),
    ai_usage: {
      calls: [
        {provider: "gemini", prompt_tokens: 10, output_tokens: 20, total_tokens: 30},
        {provider: "kimi", prompt_tokens: 5, output_tokens: 6, total_tokens: 11},
      ],
    },
    explanation_review: {
      usage: [
        {provider: "gemini", prompt_tokens: 3, output_tokens: 4, total_tokens: 7},
        {provider: "kimi", prompt_tokens: 2, output_tokens: 8, total_tokens: 10},
      ],
    },
  };

  const entry = createEntryFromMetadata("20990101-060606", payload);

  assert.equal(entry.token_usage.question.gemini.total_tokens, 30);
  assert.equal(entry.token_usage.question.kimi.total_tokens, 11);
  assert.equal(entry.token_usage.explanation.gemini.total_tokens, 7);
  assert.equal(entry.token_usage.explanation.kimi.total_tokens, 10);
});

test("schema validators report warnings without throwing", () => {
  assert.ok(validateQuestion({mapel: "Penalaran Umum"}, "soal.json").length > 0);
  assert.ok(validateMetadata({run_id: "bad"}, "metadata.json").length > 0);
  assert.ok(validateBankIndex([{run_id: "bad", status: "published"}], "bank/index.json").length > 0);
});

test("legacy Matematika metadata is indexed through compatibility mapping", () => {
  const entry = createEntryFromMetadata("20990101-040404", metadata("Matematika", "Persamaan Linear"));

  assert.equal(entry.subtes, "pengetahuan-kuantitatif");
  assert.equal(entry.topik, "aljabar-dan-fungsi");
  assert.equal(entry.path, "saved/PK/aljabar-dan-fungsi/20990101-040404");
});

test("index writes are queued across concurrent mutations", async () => {
  await writeIndex([]);

  await Promise.all([
    addEntry({run_id: "20990101-050001", status: "saved"}),
    addEntry({run_id: "20990101-050002", status: "approved"}),
    addEntry({run_id: "20990101-050003", status: "rejected"}),
  ]);

  const entries = await readIndex();
  assert.deepEqual(
    entries.map((entry) => entry.run_id).sort(),
    ["20990101-050001", "20990101-050002", "20990101-050003"],
  );
});
