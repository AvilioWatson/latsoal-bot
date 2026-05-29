export function validateGeneratorOutput(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Output generator kosong atau bukan object.");
  }

  if (!payload.run_id) {
    throw new Error("Output generator tidak memiliki run_id.");
  }

  const question = payload.question;
  if (!question || typeof question !== "object") {
    throw new Error("Output generator tidak memiliki question.");
  }

  for (const field of ["mapel", "topik", "level", "soal", "jawaban", "pembahasan"]) {
    if (typeof question[field] !== "string" || question[field].trim() === "") {
      throw new Error(`Question tidak memiliki field string '${field}'.`);
    }
  }

  if (!question.pilihan || typeof question.pilihan !== "object" || Array.isArray(question.pilihan)) {
    throw new Error("Question tidak memiliki object pilihan.");
  }

  const expectedChoices = ["A", "B", "C", "D", "E"];
  const actualChoices = Object.keys(question.pilihan).sort();
  if (actualChoices.join(",") !== expectedChoices.join(",")) {
    throw new Error("Question harus memiliki pilihan tepat A sampai E.");
  }

  for (const key of expectedChoices) {
    if (typeof question.pilihan[key] !== "string" || question.pilihan[key].trim() === "") {
      throw new Error(`Question tidak memiliki pilihan ${key}.`);
    }
  }

  if (!expectedChoices.includes(question.jawaban)) {
    throw new Error("Jawaban harus berupa salah satu dari A, B, C, D, atau E.");
  }

  const normalizedChoices = expectedChoices.map((key) => question.pilihan[key].trim().toLowerCase());
  if (new Set(normalizedChoices).size !== normalizedChoices.length) {
    throw new Error("Pilihan jawaban tidak boleh duplikat.");
  }

  const caption = payload.caption;
  if (!caption || typeof caption !== "object") {
    throw new Error("Output generator tidak memiliki caption.");
  }

  if (typeof caption.caption !== "string" || caption.caption.trim() === "") {
    throw new Error("Caption tidak memiliki teks caption.");
  }

  if (!Array.isArray(caption.hashtag) || caption.hashtag.length === 0) {
    throw new Error("Caption hashtag harus berupa array yang tidak kosong.");
  }

  if (caption.hashtag.some((tag) => typeof tag !== "string" || !tag.startsWith("#"))) {
    throw new Error("Setiap hashtag harus berupa string yang diawali '#'.");
  }

  if (!payload.validation || typeof payload.validation !== "object") {
    throw new Error("Output generator tidak memiliki validation.");
  }

  if (typeof payload.validation.skor !== "number") {
    throw new Error("Validation tidak memiliki skor number.");
  }

  if (payload.validation.skor < 0 || payload.validation.skor > 100) {
    throw new Error("Validation skor harus berada di rentang 0 sampai 100.");
  }

  return payload;
}
