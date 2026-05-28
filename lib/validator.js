export function validateGeneratorOutput(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Output generator kosong atau bukan object.");
  }
  if (!payload.run_id) {
    throw new Error("Output generator tidak memiliki run_id.");
  }
  if (!payload.question || typeof payload.question !== "object") {
    throw new Error("Output generator tidak memiliki question.");
  }
  if (!payload.caption || typeof payload.caption !== "object") {
    throw new Error("Output generator tidak memiliki caption.");
  }
  return payload;
}
