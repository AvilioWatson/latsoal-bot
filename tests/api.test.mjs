import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ID = "20990101-010101";

function metadata() {
  const question = {
    mapel: "Penalaran Umum",
    topik: "Penalaran deduktif",
    level: "mudah",
    soal: "Jika semua peserta disiplin belajar dan sebagian peserta mengikuti tryout, simpulan mana yang paling aman?",
    pilihan: {
      A: "Semua peserta mengikuti tryout.",
      B: "Sebagian peserta disiplin belajar.",
      C: "Tidak ada peserta yang mengikuti tryout.",
      D: "Semua peserta tidak disiplin belajar.",
      E: "Sebagian peserta tidak mengikuti UTBK.",
    },
    jawaban: "B",
    pembahasan: "Karena semua peserta disiplin belajar, setiap kelompok yang merupakan peserta tetap termasuk disiplin belajar. Simpulan yang aman adalah sebagian peserta disiplin belajar.",
  };

  return {
    ok: true,
    run_id: RUN_ID,
    source: "draft",
    review_status: "ready",
    question,
    caption: {
      caption: "Latihan penalaran deduktif singkat untuk review konsep.",
      hashtag: ["#UTBK2026", "#LatsoalUTBK"],
    },
    validation: {
      lolos_validasi: true,
      skor: 91,
      issues: [],
      catatan: {},
      saran_perbaikan: "",
    },
  };
}

async function writeOutput(dataRoot) {
  const runDir = path.join(dataRoot, "outputs", RUN_ID);
  const payload = metadata();
  await mkdir(runDir, {recursive: true});
  await writeFile(path.join(runDir, "metadata.json"), JSON.stringify(payload, null, 2), "utf-8");
  await writeFile(path.join(runDir, "soal.json"), JSON.stringify(payload.question, null, 2), "utf-8");
  await writeFile(path.join(runDir, "caption.txt"), "Latihan penalaran deduktif\n\n#UTBK2026 #LatsoalUTBK\n", "utf-8");
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 8000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError || new Error("Server did not become healthy.");
}

test("bank review API can save, approve, export, and delete in an isolated data root", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "latsoal-api-"));
  const port = 18765 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  await writeOutput(dataRoot);

  const server = spawn("node", ["server.js"], {
    cwd: ROOT,
    env: {...process.env, PORT: String(port), LATSOAL_DATA_ROOT: dataRoot},
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForHealth(baseUrl);

    let response = await fetch(`${baseUrl}/`);
    let body;
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "same-origin");

    response = await fetch(`${baseUrl}/assets/..%2Fserver.js`);
    assert.equal(response.status, 403);

    response = await fetch(`${baseUrl}/config`, {headers: {Accept: "application/json"}});
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    body = await response.json();
    assert.ok(body.topics["Penalaran Umum"]);
    assert.equal(body.subtest_codes["Penalaran Umum"], "PU");
    assert.equal(body.topic_aliases["Pengetahuan Kuantitatif"]["Persamaan Linear"], "Aljabar dan Fungsi");

    response = await fetch(`${baseUrl}/saved/penalaran-umum`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);

    response = await fetch(`${baseUrl}/edit/${RUN_ID}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    body = await response.text();
    assert.match(body, /Edit Gambar/);
    assert.match(body, /questionEditorForm/);
    assert.doesNotMatch(body, /jsonEditor/);

    response = await fetch(`${baseUrl}/dashboard`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);

    response = await fetch(`${baseUrl}/stats`, {headers: {Accept: "application/json"}});
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.total, 0);
    assert.deepEqual(body.by_status, {saved: 0, approved: 0, rejected: 0});

    response = await fetch(`${baseUrl}/stats`, {headers: {Accept: "text/html"}});
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);

    response = await fetch(`${baseUrl}/route-does-not-exist`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");

    response = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({mapel: "Subtes Palsu"}),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Subtes tidak valid/);

    response = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({mapel: "Penalaran Umum", topik: "Topik Palsu"}),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Topik tidak tersedia/);

    response = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({level: "ekstrem"}),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Level tidak valid/);

    response = await fetch(`${baseUrl}/saved`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({run_id: RUN_ID}),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).run_id, RUN_ID);

    response = await fetch(`${baseUrl}/saved`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: "{not-json",
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /JSON valid/);

    response = await fetch(`${baseUrl}/saved`, {headers: {Accept: "application/json"}});
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].status, "saved");
    assert.equal(body.items[0].uploaded_at, null);

    response = await fetch(`${baseUrl}/saved/${RUN_ID}`, {headers: {Accept: "application/json"}});
    assert.equal(response.status, 200);
    body = await response.json();
    const revisedExplanation = `${body.question.pembahasan} Revisi AI sudah dibuat lebih formal.`;
    response = await fetch(`${baseUrl}/saved/${RUN_ID}/explanation-review/apply`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        question_revisi: {...body.question, pembahasan: revisedExplanation},
        explanation_review: {
          lolos: true,
          skor: 95,
          akurasi: "Akurat",
          bahasa_formal: "Formal",
          catatan: [],
          saran_revisi: ["Pembahasan diformalkan."],
          pembahasan_revisi: revisedExplanation,
        },
      }),
    });
    assert.equal(response.status, 200);
    let reviewBody = await response.json();
    assert.equal(reviewBody.question.pembahasan, revisedExplanation);
    assert.equal(reviewBody.explanation_review.lolos, true);
    assert.equal(reviewBody.review_status, "ready");

    response = await fetch(`${baseUrl}/saved/${RUN_ID}/explanation-review/apply`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({question_revisi: {soal: "tidak lengkap"}, explanation_review: {lolos: false}}),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Draft revisi belum valid/);

    response = await fetch(`${baseUrl}/saved/${RUN_ID}`, {headers: {Accept: "application/json"}});
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.question.pembahasan, revisedExplanation);
    const edited = {
      ...body,
      question: {
        ...body.question,
        topik: "Penalaran induktif",
        soal: "Jika pola data meningkat secara konsisten, simpulan paling aman adalah pola tersebut berlanjut pada data berikutnya.",
      },
      caption: {
        caption: "Penalaran Umum\nPenalaran induktif",
        hashtag: ["#UTBK2026", "#LatsoalUTBK", "#SoalUTBK"],
      },
    };
    delete edited.web_files;
    delete edited.canonical_topik;
    response = await fetch(`${baseUrl}/saved/${RUN_ID}/json`, {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(edited),
    });
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.metadata.question.topik, "Penalaran induktif");
    assert.equal(body.metadata.caption.hashtag.length, 3);

    response = await fetch(`${baseUrl}/saved/${RUN_ID}/json`, {
      method: "PUT",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...edited, run_id: "20990101-999999"}),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /run_id metadata/);

    response = await fetch(`${baseUrl}/saved/${RUN_ID}`, {headers: {Accept: "application/json"}});
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.question.topik, "Penalaran induktif");
    const savedIndex = JSON.parse(await readFile(path.join(dataRoot, "bank", "index.json"), "utf-8"));
    const savedMetadata = JSON.parse(await readFile(path.join(dataRoot, savedIndex[0].path, "metadata.json"), "utf-8"));
    const savedQuestion = JSON.parse(await readFile(path.join(dataRoot, savedIndex[0].path, "soal.json"), "utf-8"));
    const savedCaption = await readFile(path.join(dataRoot, savedIndex[0].path, "caption.txt"), "utf-8");
    assert.equal(savedMetadata.question.topik, "Penalaran induktif");
    assert.equal(savedQuestion.topik, "Penalaran induktif");
    assert.match(savedCaption, /#SoalUTBK/);

    response = await fetch(`${baseUrl}/saved/${RUN_ID}/status`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({status: "approved"}),
    });
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.status, "approved");
    assert.match(body.status_updated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.approved_at, body.status_updated_at);

    response = await fetch(`${baseUrl}/saved/${RUN_ID}/status`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({status: "published"}),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Status tidak valid/);

    response = await fetch(`${baseUrl}/saved/${RUN_ID}/uploaded`, {method: "POST"});
    assert.equal(response.status, 200);
    body = await response.json();
    assert.match(body.uploaded_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.status, "approved");

    response = await fetch(`${baseUrl}/saved`, {headers: {Accept: "application/json"}});
    assert.equal(response.status, 200);
    body = await response.json();
    assert.match(body.items[0].uploaded_at, /^\d{4}-\d{2}-\d{2}T/);

    response = await fetch(`${baseUrl}/saved/${RUN_ID}/unuploaded`, {method: "POST"});
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.uploaded_at, null);
    assert.equal(body.status, "approved");

    response = await fetch(`${baseUrl}/saved`, {headers: {Accept: "application/json"}});
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.items[0].uploaded_at, null);

    response = await fetch(`${baseUrl}/export`, {method: "POST"});
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.total, 1);

    const manifest = JSON.parse(await readFile(path.join(dataRoot, body.manifest.replace(/^\//, "")), "utf-8"));
    assert.equal(manifest.total, 1);
    assert.equal(manifest.items[0].run_id, RUN_ID);
    assert.match(manifest.items[0].status_updated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(manifest.items[0].approved_at, manifest.items[0].status_updated_at);
    assert.equal(manifest.items[0].question_file, `${RUN_ID}/soal.json`);
    assert.equal(manifest.items[0].caption_file, `${RUN_ID}/caption.txt`);
    assert.equal(manifest.items[0].metadata_file, `${RUN_ID}/metadata.json`);

    const indexAfterExport = JSON.parse(await readFile(path.join(dataRoot, "bank", "index.json"), "utf-8"));
    assert.equal(indexAfterExport[0].export_batch_id, body.export_id);
    assert.match(indexAfterExport[0].exported_at, /^\d{4}-\d{2}-\d{2}T/);

    response = await fetch(`${baseUrl}/stats`, {headers: {Accept: "application/json"}});
    assert.equal(response.status, 200);
    const statsAfterExport = await response.json();
    assert.equal(statsAfterExport.total, 1);
    assert.equal(statsAfterExport.by_status.approved, 1);
    assert.equal(statsAfterExport.export_batches, 1);
    assert.equal(statsAfterExport.pending_export, 0);

    response = await fetch(`${baseUrl}/saved/${RUN_ID}`, {method: "DELETE"});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).deleted, true);

    response = await fetch(`${baseUrl}/saved`, {headers: {Accept: "application/json"}});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).items.length, 0);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
    await rm(dataRoot, {recursive: true, force: true});
  }
});
