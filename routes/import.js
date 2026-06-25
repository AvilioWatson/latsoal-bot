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

const EXTRACTION_PROMPT = `Anda adalah editor dan validator soal UTBK/SNBT. Ekstrak seluruh soal pilihan ganda dari PDF yang saya lampirkan dan keluarkan hasilnya sebagai satu JSON array valid.

Aturan kerja:
1. Ambil setiap stem, pilihan jawaban, tabel, dan informasi penting dari PDF secara akurat.
2. Setiap soal harus memiliki pilihan tepat A, B, C, D, dan E yang semuanya non-empty dan tidak duplikat.
3. Tentukan jawaban yang benar dengan mengerjakan soal secara mandiri. Field jawaban hanya boleh satu huruf kapital A-E.
4. Buat atau rapikan pembahasan dalam bahasa Indonesia formal, runtut, dan cukup untuk membuktikan jawaban.
5. Gunakan mapel dan topik resmi yang paling sesuai. Level hanya boleh mudah, sedang, atau sulit.
6. Untuk matematika gunakan LaTeX inline dengan delimiter $...$. Escape backslash sesuai aturan JSON.
7. Jika soal membutuhkan gambar, grafik, tabel, atau diagram, set butuh_visual ke true dan tulis deskripsi_visual lengkap. Jangan mengarang detail yang tidak terlihat.
8. Isi konsep_kunci dan tips_pengerjaan secara spesifik dan ringkas.
9. sumber_pdf bersifat opsional. Biarkan nama_file dan halaman sebagai string kosong jika tidak diperlukan.
10. Jangan menggabungkan dua soal, jangan menghilangkan konteks, dan jangan menambah fakta yang tidak tersedia.

Aturan keluaran:
- Keluarkan hanya JSON array valid.
- Jangan gunakan markdown, code fence, komentar, atau teks di luar JSON.
- Pertahankan struktur setiap object persis seperti template yang diberikan.

Template JSON:
${JSON.stringify(TEMPLATE, null, 2)}`;

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
      prompt: EXTRACTION_PROMPT,
      template: TEMPLATE,
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
