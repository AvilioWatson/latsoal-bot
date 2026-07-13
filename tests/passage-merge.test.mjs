import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEFT_RUN_ID = "20990101-030101";
const RIGHT_RUN_ID = "20990101-030102";

function question(runId, number, passage) {
  return {
    run_id: runId,
    source: "import",
    review_status: "ready",
    question: {
      mapel: "Pengetahuan dan Pemahaman Umum",
      topik: "Wacana",
      level: "sedang",
      soal: number === 1 ? "Gagasan utama bacaan tersebut adalah..." : "Makna kata yang paling tepat pada bacaan adalah...",
      pilihan: {A: "Pilihan A", B: "Pilihan B", C: "Pilihan C", D: "Pilihan D", E: "Pilihan E"},
      jawaban: "A",
      pembahasan: "Pembahasan singkat dan formal untuk memeriksa jawaban.",
      bacaan: passage,
    },
    caption: {caption: "Latihan wacana", hashtag: ["#UTBK"]},
    validation: {lolos_validasi: true, skor: 90, issues: [], catatan: {}},
    files: {question: "soal.json", caption: "caption.txt", images: ["1.jpg"]},
  };
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become healthy.");
}

test("passage merge combines two eligible questions under the active passage", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "latsoal-passage-merge-"));
  const taxonomyPath = path.join(dataRoot, "taxonomy.json");
  const port = 19800 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const leftDir = path.join(dataRoot, "saved", LEFT_RUN_ID);
  const rightDir = path.join(dataRoot, "saved", RIGHT_RUN_ID);
  const leftPassage = {id: "PPU-001", judul: "Bacaan Aktif", teks: "Teks bacaan aktif yang akan dipakai bersama.", nomor_soal: 1, total_soal: 1};
  const rightPassage = {id: "PPU-002", judul: "Bacaan Lama", teks: "Teks bacaan lain yang akan diganti.", nomor_soal: 1, total_soal: 1};
  const left = question(LEFT_RUN_ID, 1, leftPassage);
  const right = question(RIGHT_RUN_ID, 2, rightPassage);
  await mkdir(leftDir, {recursive: true});
  await mkdir(rightDir, {recursive: true});
  await writeFile(taxonomyPath, await readFile(path.join(ROOT, "config", "taxonomy.json"), "utf-8"), "utf-8");
  for (const [dir, metadata] of [[leftDir, left], [rightDir, right]]) {
    await writeFile(path.join(dir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");
    await writeFile(path.join(dir, "soal.json"), JSON.stringify(metadata.question, null, 2), "utf-8");
    await writeFile(path.join(dir, "caption.txt"), "Latihan wacana\n\n#UTBK\n", "utf-8");
    await writeFile(path.join(dir, "1.jpg"), "old image", "utf-8");
  }
  await mkdir(path.join(dataRoot, "bank"), {recursive: true});
  await writeFile(path.join(dataRoot, "bank", "index.json"), JSON.stringify([
    {run_id: LEFT_RUN_ID, status: "saved", path: `saved/${LEFT_RUN_ID}`},
    {run_id: RIGHT_RUN_ID, status: "saved", path: `saved/${RIGHT_RUN_ID}`},
  ]), "utf-8");

  const server = spawn("node", ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      LATSOAL_DATA_ROOT: dataRoot,
      LATSOAL_TAXONOMY_PATH: taxonomyPath,
      GEMINI_API_KEY: "",
      KIMI_API_KEY: "",
      NVIDIA_API_KEY: "",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForHealth(baseUrl);
    const response = await fetch(`${baseUrl}/saved/${LEFT_RUN_ID}/merge-passage`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({other_run_id: RIGHT_RUN_ID}),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).merged_run_ids, [LEFT_RUN_ID, RIGHT_RUN_ID]);

    const [storedLeft, storedRight] = await Promise.all([
      readFile(path.join(leftDir, "metadata.json"), "utf-8").then(JSON.parse),
      readFile(path.join(rightDir, "metadata.json"), "utf-8").then(JSON.parse),
    ]);
    assert.equal(storedLeft.question.bacaan.teks, leftPassage.teks);
    assert.equal(storedRight.question.bacaan.teks, leftPassage.teks);
    assert.equal(storedLeft.question.bacaan.total_soal, 2);
    assert.equal(storedRight.question.bacaan.total_soal, 2);
    assert.deepEqual([storedLeft.question.bacaan.nomor_soal, storedRight.question.bacaan.nomor_soal], [1, 2]);
    assert.equal(storedLeft.review_status, "needs_review");
    assert.equal(storedRight.review_status, "needs_review");
    assert.deepEqual(storedLeft.files.images, []);
    assert.deepEqual(storedRight.files.images, []);
  } finally {
    server.kill("SIGKILL");
    await rm(dataRoot, {recursive: true, force: true});
  }
});
