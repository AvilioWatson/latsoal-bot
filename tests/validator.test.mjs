import assert from "node:assert/strict";
import test from "node:test";
import {validateGeneratorOutput} from "../lib/validator.js";

function validPayload() {
  return {
    ok: true,
    run_id: "20260529-123456",
    question: {
      mapel: "Penalaran Umum",
      topik: "Penalaran deduktif",
      level: "mudah",
      soal: "Jika semua peserta rajin belajar dan sebagian peserta mengikuti tryout, simpulan mana yang paling tepat?",
      pilihan: {
        A: "Semua peserta mengikuti tryout.",
        B: "Sebagian peserta rajin belajar.",
        C: "Tidak ada peserta yang rajin belajar.",
        D: "Semua peserta tidak mengikuti tryout.",
        E: "Sebagian peserta tidak belajar.",
      },
      jawaban: "B",
      pembahasan: "Karena semua peserta rajin belajar, maka kelompok mana pun yang merupakan peserta juga rajin belajar. Simpulan paling aman adalah sebagian peserta rajin belajar.",
    },
    caption: {
      caption: "Latihan singkat untuk mengasah penalaran deduktif sebelum tryout.",
      hashtag: ["#UTBK", "#UTBK2027", "#LatsoalUTBK"],
    },
    validation: {
      lolos_validasi: true,
      skor: 92,
      issues: [],
      catatan: {},
      saran_perbaikan: "",
    },
  };
}

test("validateGeneratorOutput accepts a complete generator payload", () => {
  const payload = validPayload();
  assert.equal(validateGeneratorOutput(payload), payload);
});

test("validateGeneratorOutput rejects missing explanation", () => {
  const payload = validPayload();
  payload.question.pembahasan = "";
  assert.throws(() => validateGeneratorOutput(payload), /pembahasan/);
});

test("validateGeneratorOutput rejects incomplete choices", () => {
  const payload = validPayload();
  delete payload.question.pilihan.E;
  assert.throws(() => validateGeneratorOutput(payload), /pilihan tepat A sampai E/);
});

test("validateGeneratorOutput rejects duplicate choices", () => {
  const payload = validPayload();
  payload.question.pilihan.E = payload.question.pilihan.D;
  assert.throws(() => validateGeneratorOutput(payload), /duplikat/);
});

test("validateGeneratorOutput rejects answers outside A-E", () => {
  const payload = validPayload();
  payload.question.jawaban = "F";
  assert.throws(() => validateGeneratorOutput(payload), /A, B, C, D, atau E/);
});

test("validateGeneratorOutput rejects empty hashtags", () => {
  const payload = validPayload();
  payload.caption.hashtag = [];
  assert.throws(() => validateGeneratorOutput(payload), /tidak kosong/);
});

test("validateGeneratorOutput rejects out-of-range validation score", () => {
  const payload = validPayload();
  payload.validation.skor = 101;
  assert.throws(() => validateGeneratorOutput(payload), /0 sampai 100/);
});
