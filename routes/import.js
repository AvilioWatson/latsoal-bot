import {spawn} from "node:child_process";
import path from "node:path";
import {rebuildIndex} from "../lib/filestore.js";
import {errorStatus, readJsonBody, sendError, sendJson} from "../lib/http.js";
import {ROOT} from "../lib/paths.js";
import {requestError} from "../lib/route-utils.js";
import {TAXONOMY} from "../lib/taxonomy.js";

const PYTHON = process.env.PYTHON || "python";
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_BATCH = 1000;
const PASSAGE_SUBTESTS = new Set([
  "Penalaran Matematika",
  "Literasi Bahasa Indonesia",
  "Literasi Bahasa Inggris",
  "Pengetahuan dan Pemahaman Umum",
]);

const TEMPLATE = [{
  mapel: "Pengetahuan Kuantitatif",
  kelompok_tes: "TPS",
  topik: "Aljabar Dan Fungsi",
  level: "sedang",
  soal: "Tuliskan teks soal lengkap. Gunakan $...$ untuk notasi matematika.",
  pilihan: {A: "Pilihan A", B: "Pilihan B", C: "Pilihan C", D: "Pilihan D", E: "Pilihan E"},
  jawaban: "A",
  pembahasan: "Jelaskan penyelesaian secara runtut dan buktikan jawaban yang benar.",
  konsep_kunci: "Konsep utama yang diuji.",
  tips_pengerjaan: "Strategi singkat untuk mengerjakan soal.",
  butuh_visual: false,
  deskripsi_visual: "",
  sumber_pdf: {nama_file: "", halaman: ""},
}];

function templateForSubtest(mapel) {
  const topics = TAXONOMY.topics?.[mapel] || [];
  const template = {
    mapel,
    kelompok_tes: PASSAGE_SUBTESTS.has(mapel) ? (mapel === "Penalaran Matematika" ? "Tes Literasi" : "TPS") : "TPS",
    topik: topics[0] || "",
    level: "sedang",
    soal: PASSAGE_SUBTESTS.has(mapel)
      ? "Tulis pertanyaan spesifik nomor 1 yang merujuk pada bacaan, tanpa menyalin ulang seluruh bacaan."
      : "Tuliskan teks soal lengkap. Gunakan $...$ untuk notasi matematika.",
    pilihan: {A: "Pilihan A", B: "Pilihan B", C: "Pilihan C", D: "Pilihan D", E: "Pilihan E"},
    jawaban: "A",
    pembahasan: "Jelaskan penyelesaian secara runtut dan buktikan jawaban yang benar.",
    konsep_kunci: "Konsep utama yang diuji.",
    tips_pengerjaan: "Strategi singkat untuk mengerjakan soal.",
    butuh_visual: false,
    deskripsi_visual: "",
    sumber_pdf: {nama_file: "", halaman: ""},
  };
  if (PASSAGE_SUBTESTS.has(mapel)) {
    template.bacaan = {
      id: `${TAXONOMY.subtest_codes?.[mapel] || "SUB"}-001`,
      judul: "Judul atau konteks bacaan",
      teks: "Tulis satu bacaan lengkap yang sama untuk 1 sampai 5 soal.",
      bahasa: mapel === "Literasi Bahasa Inggris" ? "en" : "id",
      nomor_soal: 1,
      total_soal: 3,
      sumber_pdf: {nama_file: "", halaman: ""},
    };
  }
  return [template];
}

function templatesBySubtest() {
  return Object.fromEntries(Object.keys(TAXONOMY.topics || {}).map((mapel) => [mapel, templateForSubtest(mapel)]));
}

function topicListForPrompt(mapel) {
  return (TAXONOMY.topics?.[mapel] || []).map((topic) => `  - ${topic}`).join("\n");
}

function subtestPrompt(mapel, index) {
  const code = TAXONOMY.subtest_codes?.[mapel] || mapel;
  return `${index}. Prompt ${code} - ${mapel}
Gunakan field mapel persis: "${mapel}".
Klasifikasikan setiap soal ke salah satu topik resmi berikut:
${topicListForPrompt(mapel)}`;
}

function extractionPrompt() {
  const subtestPrompts = Object.keys(TAXONOMY.topics || {}).map(subtestPrompt).join("\n\n");
  return `Anda adalah editor dan validator soal UTBK/SNBT. Ekstrak seluruh soal pilihan ganda dari PDF yang saya lampirkan dan buat hasilnya sebagai file .json yang bisa saya download. Isi file harus berupa satu JSON array valid.

Aturan kerja:
1. Ambil setiap stem, pilihan jawaban, tabel, dan informasi penting dari PDF secara akurat.
2. Setiap soal harus memiliki pilihan tepat A, B, C, D, dan E yang semuanya non-empty dan tidak duplikat.
3. Tentukan jawaban yang benar dengan mengerjakan soal secara mandiri. Field jawaban hanya boleh satu huruf kapital A-E.
4. Buat atau rapikan pembahasan dalam bahasa Indonesia formal, runtut, dan cukup untuk membuktikan jawaban.
5. Gunakan mapel dan topik resmi yang paling sesuai dari daftar subtes dan subtopik di bawah. Level hanya boleh mudah, sedang, atau sulit.
6. Untuk matematika gunakan LaTeX inline dengan delimiter $...$. Escape backslash sesuai aturan JSON.
7. Jika soal membutuhkan gambar, grafik, tabel, atau diagram, set butuh_visual ke true dan tulis deskripsi_visual lengkap. Jangan mengarang detail yang tidak terlihat.
8. Isi konsep_kunci dan tips_pengerjaan secara spesifik dan ringkas.
9. sumber_pdf bersifat opsional. Biarkan nama_file dan halaman sebagai string kosong jika tidak diperlukan.
10. Jangan menggabungkan dua soal, jangan menghilangkan konteks, dan jangan menambah fakta yang tidak tersedia.

Daftar 7 prompt subtes dan subtopik resmi website:
${subtestPrompts}

Jika PDF hanya berisi satu subtes, pakai prompt subtes yang sesuai. Jika PDF campuran, klasifikasikan setiap soal per object berdasarkan mapel dan topik resmi terdekat. Jangan membuat judul topik baru di luar daftar.

Aturan keluaran:
- Buat file .json yang bisa didownload, berisi hanya JSON array valid.
- Jika platform tidak mendukung pembuatan file, tampilkan hanya JSON array valid agar bisa saya simpan manual sebagai file .json.
- Jangan gunakan markdown, code fence, komentar, atau teks di luar JSON/file.
- Pertahankan struktur setiap object persis seperti template yang diberikan.

Template JSON:
${JSON.stringify(TEMPLATE, null, 2)}`;
}

function extractionPromptForSubtest(mapel) {
  const code = TAXONOMY.subtest_codes?.[mapel] || mapel;
  const usesPassage = PASSAGE_SUBTESTS.has(mapel);
  const passageRules = usesPassage ? `
Aturan khusus ${code}:
- Format utama adalah 1 bacaan untuk satu atau beberapa soal terkait. Jumlahnya mengikuti PDF, bisa 1 sampai 5 soal.
- Untuk setiap set bacaan, buat satu object soal terpisah per nomor dalam JSON array.
- Object dalam set yang sama harus memiliki field bacaan.id yang sama, bacaan.teks yang sama, bacaan.total_soal sesuai jumlah soal pada set tersebut, dan bacaan.nomor_soal berurutan mulai dari 1.
- Field soal berisi pertanyaan per nomor saja; jangan menyalin ulang seluruh bacaan ke field soal.
- Setiap pembahasan harus merujuk bagian bacaan yang relevan dan tetap membuktikan jawaban benar.` : `
Aturan khusus ${code}:
- Gunakan format soal mandiri seperti template.
- Field bacaan tidak wajib dan boleh dihilangkan.`;
  return `Anda adalah editor dan validator soal UTBK/SNBT. Ekstrak soal pilihan ganda dari PDF untuk subtes ${code} - ${mapel}, lalu buat hasilnya sebagai file .json yang bisa saya download. Isi file harus berupa satu JSON array valid.

Aturan umum:
1. Gunakan field mapel persis: "${mapel}".
2. Klasifikasikan topik hanya dari daftar resmi berikut:
${topicListForPrompt(mapel)}
3. Setiap soal wajib punya pilihan A, B, C, D, dan E yang non-empty dan tidak duplikat.
4. Field jawaban hanya boleh satu huruf kapital A-E.
5. Level hanya boleh mudah, sedang, atau sulit.
6. Pembahasan memakai bahasa Indonesia formal, runtut, dan cukup untuk membuktikan jawaban.
7. Untuk matematika gunakan LaTeX inline dengan delimiter $...$ dan escape backslash sesuai JSON.
8. Jika butuh gambar/grafik/tabel/diagram, set butuh_visual true dan isi deskripsi_visual lengkap.
9. Jangan membuat topik baru di luar daftar resmi.
${passageRules}

Aturan keluaran:
- Buat file .json yang bisa didownload, berisi hanya JSON array valid.
- Jika platform tidak mendukung pembuatan file, tampilkan hanya JSON array valid agar bisa saya simpan manual sebagai file .json.
- Jangan gunakan markdown, code fence, komentar, atau teks di luar JSON/file.
- Pertahankan struktur object seperti template.

Template JSON:
${JSON.stringify(templateForSubtest(mapel), null, 2)}`;
}

function promptsBySubtest() {
  return Object.fromEntries(Object.keys(TAXONOMY.topics || {}).map((mapel) => [mapel, extractionPromptForSubtest(mapel)]));
}

let importQueue = Promise.resolve();

function runImporter(payload, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [path.join(ROOT, "scripts", "import_questions.py"), "-", ...args], {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      let result;
      try {
        result = JSON.parse(stdout.trim() || "{}");
      } catch {
        reject(requestError(500, stderr.trim() || "Output importer bukan JSON valid."));
        return;
      }
      if (code !== 0 || !result.ok) {
        reject(requestError(400, result.error || stderr.trim() || "Import gagal."));
        return;
      }
      resolve(result);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function validatePayloadShape(payload) {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) throw requestError(400, "questions harus berupa JSON array.");
  if (questions.length > MAX_BATCH) throw requestError(400, `Maksimal ${MAX_BATCH} soal per batch.`);
  return payload;
}

async function parseImportBody(request) {
  return validatePayloadShape(await readJsonBody(request, {limitBytes: MAX_BODY_BYTES}));
}

export async function handle(request, response, route) {
  if (request.method === "GET" && route === "/api/import/config") {
    sendJson(response, {
      prompt: extractionPrompt(),
      template: TEMPLATE,
      prompts: promptsBySubtest(),
      templates: templatesBySubtest(),
      default_subtest: "Penalaran Matematika",
      passage_subtests: [...PASSAGE_SUBTESTS],
      max_batch: MAX_BATCH,
      max_body_bytes: MAX_BODY_BYTES,
      threshold: Number(process.env.DEDUP_THRESHOLD || 0.82),
      topics: TAXONOMY.topics,
    });
    return true;
  }

  if (request.method === "POST" && route === "/api/import/validate") {
    try {
      const payload = await parseImportBody(request);
      sendJson(response, await runImporter(payload, ["--validate-only", "--skip-render"]));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && route === "/api/import") {
    try {
      const payload = await parseImportBody(request);
      const account = typeof payload.account === "string" && payload.account.trim()
        ? payload.account.trim().slice(0, 80)
        : "@utbk_neareducation";
      const task = async () => {
        const result = await runImporter(payload, ["--skip-render", "--account", account]);
        await rebuildIndex();
        return result;
      };
      const resultPromise = importQueue.then(task, task);
      importQueue = resultPromise.catch(() => {});
      sendJson(response, await resultPromise);
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  return false;
}
