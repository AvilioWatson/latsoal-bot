import assert from "node:assert/strict";
import test from "node:test";
import {metadataToTryoutQuestion, metadataToTryoutQuestions} from "../lib/tryout-export.js";

test("metadataToTryoutQuestion maps saved metadata to tryout export v1", () => {
  const item = metadataToTryoutQuestion("20990101-010101", {
    source: "import",
    review_status: "ready",
    question: {
      mapel: "Penalaran Umum",
      topik: "Penalaran Deduktif",
      level: "mudah",
      soal: "Jika semua A adalah B, simpulan mana yang valid?",
      pilihan: {
        A: "Semua A adalah B.",
        B: "Semua B adalah A.",
        C: "Tidak ada A yang B.",
        D: "Sebagian B bukan A.",
        E: "Semua jawaban salah.",
      },
      jawaban: "A",
      pembahasan: "Premis langsung menyatakan semua A adalah B.",
    },
    caption: {
      caption: "Latihan Penalaran Umum.",
      hashtag: ["#UTBK"],
    },
    validation: {lolos_validasi: true},
    dedup: {is_duplicate: false},
    files: {
      images: ["C:\\tmp\\post-1.png"],
      explanations: ["C:\\tmp\\pembahasan-1.jpg"],
    },
  }, "export-1");

  assert.equal(item.external_id, "20990101-010101");
  assert.equal(item.subtest_name, "Penalaran Umum");
  assert.equal(item.subtest_code, "PU");
  assert.equal(item.canonical_topic, "Penalaran Deduktif");
  assert.equal(item.difficulty, "easy");
  assert.equal(item.options.length, 5);
  assert.deepEqual(item.options.map((option) => option.label), ["A", "B", "C", "D", "E"]);
  assert.equal(item.correct_answer, "A");
  assert.equal(item.assets.images[0], "/approved/export-1/20990101-010101/post-1.png");
  assert.equal(item.assets.explanations[0], "/approved/export-1/20990101-010101/pembahasan-1.jpg");
  assert.deepEqual(item.warnings, []);
});

test("metadataToTryoutQuestion warns when approved question is not review-ready", () => {
  const item = metadataToTryoutQuestion("20990101-010101", {
    review_status: "needs_review",
    question: {
      mapel: "Pengetahuan Kuantitatif",
      topik: "Aljabar Dan Fungsi",
      level: "sedang",
      soal: "Nilai x adalah ...",
      pilihan: {A: "1", B: "2", C: "3", D: "4", E: "5"},
      jawaban: "B",
      pembahasan: "Substitusi nilai x.",
    },
  }, "export-2");

  assert.equal(item.difficulty, "medium");
  assert.equal(item.warnings.length, 1);
  assert.equal(item.warnings[0].code, "review_not_ready");
});

test("metadataToTryoutQuestion exports passage metadata additively", () => {
  const item = metadataToTryoutQuestion("20990101-010102", {
    review_status: "ready",
    question: {
      mapel: "Literasi Bahasa Indonesia",
      topik: "Memahami Informasi",
      level: "sedang",
      soal: "Simpulan utama bacaan tersebut adalah ...",
      bacaan: {
        id: "LBI-001",
        judul: "Ruang Terbuka",
        teks: "Ruang terbuka membantu warga berinteraksi dan menjaga kualitas udara kota.",
        bahasa: "id",
        nomor_soal: 3,
        total_soal: 5,
      },
      pilihan: {A: "A", B: "B", C: "C", D: "D", E: "E"},
      jawaban: "A",
      pembahasan: "Bacaan menekankan fungsi ruang terbuka bagi interaksi warga dan kualitas udara.",
    },
  }, "export-3");

  assert.equal(item.passage_id, "LBI-001");
  assert.equal(item.passage_order, 3);
  assert.equal(item.stem_text, "Simpulan utama bacaan tersebut adalah ...");
  assert.match(item.question_text, /Ruang terbuka membantu warga/);
});

test("metadataToTryoutQuestions flattens grouped passage questions", () => {
  const items = metadataToTryoutQuestions("20990101-010103", {
    review_status: "ready",
    question: {
      mapel: "Literasi Bahasa Indonesia",
      topik: "Memahami Informasi",
      level: "sedang",
      soal: "Soal pertama",
      pilihan: {A: "A1", B: "B1", C: "C1", D: "D1", E: "E1"},
      jawaban: "A",
      pembahasan: "Pembahasan pertama",
      group_total_soal: 2,
      bacaan: {
        id: "LBI-002",
        judul: "Transportasi",
        teks: "Transportasi publik membantu mobilitas warga dan menekan kemacetan.",
        bahasa: "id",
        nomor_soal: 1,
        total_soal: 2,
      },
      question_group: [
        {
          nomor_soal: 1,
          soal: "Soal pertama",
          pilihan: {A: "A1", B: "B1", C: "C1", D: "D1", E: "E1"},
          jawaban: "A",
          pembahasan: "Pembahasan pertama",
        },
        {
          nomor_soal: 2,
          soal: "Soal kedua",
          pilihan: {A: "A2", B: "B2", C: "C2", D: "D2", E: "E2"},
          jawaban: "B",
          pembahasan: "Pembahasan kedua",
        },
      ],
    },
  }, "export-4");

  assert.equal(items.length, 2);
  assert.equal(items[0].external_id, "20990101-010103-1");
  assert.equal(items[1].external_id, "20990101-010103-2");
  assert.equal(items[1].passage_order, 2);
  assert.equal(items[1].correct_answer, "B");
  assert.equal(items[1].stem_text, "Soal kedua");
});
