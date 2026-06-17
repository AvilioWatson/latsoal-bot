import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {buildGeneratorArgs, runGenerator} from "../lib/runner.js";

function validPayload() {
  return {
    ok: true,
    run_id: "20990101-010101",
    storage_path: "PU/penalaran-deduktif/20990101-010101",
    source: "draft",
    question: {
      mapel: "Penalaran Umum",
      topik: "Penalaran deduktif",
      level: "mudah",
      soal: "Jika semua peserta disiplin belajar dan sebagian peserta mengikuti tryout, simpulan mana yang paling aman?",
      pilihan: {
        A: "Semua peserta mengikuti tryout.",
        B: "Sebagian peserta disiplin belajar.",
        C: "Tidak ada peserta mengikuti tryout.",
        D: "Semua peserta tidak disiplin belajar.",
        E: "Sebagian peserta tidak mengikuti UTBK.",
      },
      jawaban: "B",
      pembahasan: "Karena semua peserta disiplin belajar, setiap kelompok yang merupakan peserta tetap disiplin belajar. Simpulan yang paling aman adalah sebagian peserta disiplin belajar.",
    },
    caption: {
      caption: "Latihan singkat penalaran deduktif untuk menguji ketelitian membaca premis.",
      hashtag: ["#UTBK2026", "#LatsoalUTBK"],
    },
    validation: {
      lolos_validasi: true,
      skor: 90,
      issues: [],
      catatan: {},
      saran_perbaikan: "",
    },
  };
}

async function withScript(source, callback) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "latsoal-runner-"));
  const script = path.join(dir, "generator.mjs");
  await writeFile(script, source, "utf-8");
  try {
    return await callback(script);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

test("buildGeneratorArgs preserves generator CLI contract", () => {
  assert.deepEqual(buildGeneratorArgs({
    mapel: "Penalaran Umum",
    topik: "Analogi",
    level: "sulit",
    mode: "draft",
    account: "@latsoal",
  }, "fake.py"), [
    "fake.py",
    "--mapel",
    "Penalaran Umum",
    "--topik",
    "Analogi",
    "--level",
    "sulit",
    "--mode",
    "draft",
    "--provider",
    "gemini",
    "--account",
    "@latsoal",
  ]);
});

test("runGenerator resolves valid JSON payload and adds web files", async () => {
  await withScript(`console.log(${JSON.stringify(JSON.stringify(validPayload()))});`, async (script) => {
    const result = await runGenerator({}, {python: "node", generatorScript: script, timeoutMs: 2000});
    assert.equal(result.run_id, "20990101-010101");
    assert.deepEqual(result.web_files, {
      question: "/outputs/PU/penalaran-deduktif/20990101-010101/soal.json",
      caption: "/outputs/PU/penalaran-deduktif/20990101-010101/caption.txt",
      metadata: "/outputs/PU/penalaran-deduktif/20990101-010101/metadata.json",
    });
  });
});

test("runGenerator rejects invalid JSON output", async () => {
  await withScript("console.log('not json');", async (script) => {
    await assert.rejects(
      runGenerator({}, {python: "node", generatorScript: script, timeoutMs: 2000}),
      /Output generator bukan JSON valid/,
    );
  });
});

test("runGenerator rejects generator error payload", async () => {
  await withScript(`console.log(${JSON.stringify(JSON.stringify({
    ok: false,
    error: "validation_failed",
    detail: "bad input",
  }))});`, async (script) => {
    await assert.rejects(
      runGenerator({}, {python: "node", generatorScript: script, timeoutMs: 2000}),
      (error) => error.message === "bad input" && error.payload.error === "validation_failed",
    );
  });
});

test("runGenerator rejects timeout with structured payload", async () => {
  await withScript("setTimeout(() => {}, 5000);", async (script) => {
    await assert.rejects(
      runGenerator({}, {python: "node", generatorScript: script, timeoutMs: 100}),
      (error) => error.payload?.error === "timeout" && /within 1s/.test(error.message),
    );
  });
});
