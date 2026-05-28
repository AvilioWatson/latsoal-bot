import {readJsonBody, sendError, sendJson} from "../lib/http.js";
import {runGenerator} from "../lib/runner.js";

export const TOPICS = {
  "Penalaran Umum": [
    "Penalaran deduktif",
    "Penalaran induktif",
    "Analogi",
    "Sebab akibat",
    "Penalaran analitis",
  ],
  "Pengetahuan dan Pemahaman Umum": [
    "Makna kata",
    "Hubungan antarkalimat",
    "Ide pokok",
    "Simpulan teks",
    "Kesesuaian pernyataan",
  ],
  "Pemahaman Bacaan dan Menulis": [
    "Kalimat efektif",
    "Ejaan",
    "Kohesi dan koherensi",
    "Paragraf padu",
    "Perbaikan kalimat",
  ],
  "Pengetahuan Kuantitatif": [
    "Aritmetika",
    "Aljabar dasar",
    "Perbandingan",
    "Peluang",
    "Statistika",
  ],
  "Literasi Bahasa Indonesia": [
    "Pemahaman teks informatif",
    "Pemahaman teks argumentatif",
    "Simpulan bacaan",
    "Tujuan penulis",
    "Evaluasi pernyataan",
  ],
  "Literasi Bahasa Inggris": [
    "Main idea",
    "Inference",
    "Vocabulary in context",
    "Author purpose",
    "Detail information",
  ],
  "Penalaran Matematika": [
    "Data dan ketidakpastian",
    "Bilangan",
    "Aljabar",
    "Geometri",
    "Pemodelan matematika",
  ],
};

export async function handle(request, response, route) {
  if (request.method === "GET" && route === "/api/config") {
    sendJson(response, {topics: TOPICS});
    return true;
  }

  if (request.method === "POST" && (route === "/api/generate" || route === "/generate")) {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await runGenerator(payload));
    } catch (error) {
      if (error.payload) {
        sendJson(response, error.payload, 500);
      } else {
        sendError(response, 500, error.message);
      }
    }
    return true;
  }

  return false;
}
