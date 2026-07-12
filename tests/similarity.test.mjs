import assert from "node:assert/strict";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "latsoal-similarity-"));
process.env.LATSOAL_DATA_ROOT = dataRoot;

const {checkDuplicateAgainstSaved} = await import("../lib/similarity.js");
const {writeIndex} = await import("../lib/filestore.js");
const {SAVED} = await import("../lib/paths.js");

test.after(async () => {
  await rm(dataRoot, {recursive: true, force: true});
});

function passageQuestion(number, passageId = "PM-001") {
  return {
    mapel: "Penalaran Matematika",
    topik: "Aljabar Dan Fungsi",
    level: "sedang",
    soal: `Berdasarkan bacaan, pernyataan nomor ${number} yang paling tepat adalah?`,
    pilihan: {
      A: `Pernyataan benar ${number}.`,
      B: `Pernyataan keliru ${number}.`,
      C: `Pernyataan tidak relevan ${number}.`,
      D: `Pernyataan terlalu luas ${number}.`,
      E: `Pernyataan bertentangan ${number}.`,
    },
    jawaban: "A",
    pembahasan: `Pembahasan soal ${number} mengacu pada bagian relevan di bacaan.`,
    bacaan: {
      id: passageId,
      judul: "Model Pertumbuhan",
      teks: "Sebuah UMKM mencatat pertumbuhan produksi secara linear selama beberapa bulan dan membandingkannya dengan biaya tetap untuk menentukan titik impas usaha.",
      nomor_soal: number,
      total_soal: 3,
    },
  };
}

async function saveQuestion(runId, question) {
  const runDir = path.join(SAVED, runId);
  await mkdir(runDir, {recursive: true});
  await writeFile(path.join(runDir, "metadata.json"), JSON.stringify({
    run_id: runId,
    source: "import",
    review_status: "ready",
    question,
    caption: {caption: "Latihan bacaan.", hashtag: ["#UTBK"]},
    validation: {lolos_validasi: true, skor: 90, issues: [], catatan: {}},
    files: {question: "soal.json", caption: "caption.txt"},
  }, null, 2), "utf-8");
  await writeIndex([{run_id: runId, status: "saved", path: `saved/${runId}`}]);
}

test("passage group similarity ignores question text", async () => {
  const runId = "20990101-020101";
  const savedQuestion = passageQuestion(1, "PM-001");
  const currentQuestion = structuredClone(savedQuestion);
  currentQuestion.bacaan.id = "PM-002";
  currentQuestion.bacaan.judul = "Survei Transportasi";
  currentQuestion.bacaan.teks = "Komunitas sekolah mencatat perubahan pilihan transportasi siswa setelah jadwal masuk pagi disesuaikan selama satu semester.";
  await saveQuestion(runId, savedQuestion);

  const {dedup} = await checkDuplicateAgainstSaved(currentQuestion);

  assert.equal(dedup.is_duplicate, false);
  assert.ok(dedup.similarity < dedup.threshold);
});

test("passage group similarity matches passage text", async () => {
  const runId = "20990101-020102";
  const savedQuestion = passageQuestion(1, "PM-003");
  const currentQuestion = passageQuestion(2, "PM-003");
  currentQuestion.soal = "Manakah pernyataan yang tidak dapat disimpulkan dari bacaan?";
  currentQuestion.pilihan = {
    A: "Data biaya tetap dapat dibandingkan.",
    B: "Pertumbuhan produksi dicatat beberapa bulan.",
    C: "Seluruh biaya berubah setiap hari.",
    D: "Titik impas dapat dikaji dari data.",
    E: "Produksi dibahas dalam konteks UMKM.",
  };
  await saveQuestion(runId, savedQuestion);

  const {dedup} = await checkDuplicateAgainstSaved(currentQuestion);

  assert.equal(dedup.is_duplicate, true);
  assert.equal(dedup.matched_run_id, runId);
  assert.equal(dedup.similarity, 1);
});
