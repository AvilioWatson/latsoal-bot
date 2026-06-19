import {access, readFile, writeFile} from "node:fs/promises";

export const DB_SCHEMAS = {
  bankIndex: {
    type: "array",
    itemRequired: ["run_id", "status"],
  },
  metadata: {
    type: "object",
    required: ["run_id", "question", "caption", "files"],
  },
  question: {
    type: "object",
    required: ["mapel", "topik", "level", "soal", "pilihan", "jawaban", "pembahasan"],
  },
};

export const LEGACY_MAPEL_COMPATIBILITY = {
  Matematika: "Pengetahuan Kuantitatif",
};

const VALID_STATUS = new Set(["saved", "approved", "rejected"]);
const VALID_LEVEL = new Set(["mudah", "sedang", "sulit"]);
const CHOICE_KEYS = ["A", "B", "C", "D", "E"];

function warning(path, message) {
  return {path, message};
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function compatibleMapel(mapel) {
  return LEGACY_MAPEL_COMPATIBILITY[String(mapel || "").trim()] || mapel;
}

export function validateQuestion(question, basePath = "soal") {
  const warnings = [];
  if (!isObject(question)) {
    return [warning(basePath, "soal.json harus berupa object.")];
  }
  for (const field of DB_SCHEMAS.question.required) {
    if (field === "pilihan") continue;
    if (typeof question[field] !== "string" || question[field].trim() === "") {
      warnings.push(warning(`${basePath}.${field}`, "Field wajib harus berupa string non-empty."));
    }
  }
  if (!VALID_LEVEL.has(question.level)) {
    warnings.push(warning(`${basePath}.level`, "Level tidak dikenal."));
  }
  if (!isObject(question.pilihan)) {
    warnings.push(warning(`${basePath}.pilihan`, "Pilihan harus berupa object A-E."));
  } else {
    for (const key of CHOICE_KEYS) {
      if (typeof question.pilihan[key] !== "string" || question.pilihan[key].trim() === "") {
        warnings.push(warning(`${basePath}.pilihan.${key}`, "Pilihan wajib harus berupa string non-empty."));
      }
    }
    const extra = Object.keys(question.pilihan).filter((key) => !CHOICE_KEYS.includes(key));
    for (const key of extra) {
      warnings.push(warning(`${basePath}.pilihan.${key}`, "Pilihan di luar A-E akan diabaikan."));
    }
  }
  if (!CHOICE_KEYS.includes(question.jawaban)) {
    warnings.push(warning(`${basePath}.jawaban`, "Jawaban harus salah satu dari A-E."));
  }
  return warnings;
}

export function validateMetadata(metadata, basePath = "metadata") {
  const warnings = [];
  if (!isObject(metadata)) {
    return [warning(basePath, "metadata.json harus berupa object.")];
  }
  for (const field of DB_SCHEMAS.metadata.required) {
    if (!(field in metadata)) {
      warnings.push(warning(`${basePath}.${field}`, "Field wajib tidak ada."));
    }
  }
  if (metadata.run_id && !/^\d{8}-\d{6}$/.test(String(metadata.run_id))) {
    warnings.push(warning(`${basePath}.run_id`, "run_id bukan timestamp valid."));
  }
  warnings.push(...validateQuestion(metadata.question, `${basePath}.question`));
  if (!isObject(metadata.caption)) {
    warnings.push(warning(`${basePath}.caption`, "Caption harus berupa object."));
  } else {
    if (typeof metadata.caption.caption !== "string" || metadata.caption.caption.trim() === "") {
      warnings.push(warning(`${basePath}.caption.caption`, "Caption text wajib non-empty."));
    }
    if (!Array.isArray(metadata.caption.hashtag)) {
      warnings.push(warning(`${basePath}.caption.hashtag`, "Hashtag harus berupa array."));
    }
  }
  if (!isObject(metadata.files)) {
    warnings.push(warning(`${basePath}.files`, "Files harus berupa object."));
  } else {
    for (const field of ["question", "caption"]) {
      if (typeof metadata.files[field] !== "string" || metadata.files[field].trim() === "") {
        warnings.push(warning(`${basePath}.files.${field}`, "File utama wajib berupa path string."));
      }
    }
    for (const field of ["images", "explanations"]) {
      if (metadata.files[field] !== undefined && !Array.isArray(metadata.files[field])) {
        warnings.push(warning(`${basePath}.files.${field}`, "Daftar file harus berupa array."));
      }
    }
  }
  return warnings;
}

export function validateBankIndex(entries, basePath = "bank/index.json") {
  const warnings = [];
  if (!Array.isArray(entries)) {
    return [warning(basePath, "bank/index.json harus berupa array.")];
  }
  const seenRunIds = new Set();
  entries.forEach((entry, index) => {
    const itemPath = `${basePath}[${index}]`;
    if (!isObject(entry)) {
      warnings.push(warning(itemPath, "Entry index harus berupa object."));
      return;
    }
    if (!/^\d{8}-\d{6}$/.test(String(entry.run_id || ""))) {
      warnings.push(warning(`${itemPath}.run_id`, "run_id tidak valid."));
    }
    if (seenRunIds.has(entry.run_id)) {
      warnings.push(warning(`${itemPath}.run_id`, "run_id duplikat di index."));
    }
    seenRunIds.add(entry.run_id);
    if (!VALID_STATUS.has(entry.status)) {
      warnings.push(warning(`${itemPath}.status`, "Status tidak dikenal."));
    }
    if (entry.path !== undefined && typeof entry.path !== "string") {
      warnings.push(warning(`${itemPath}.path`, "Path harus berupa string."));
    }
  });
  return warnings;
}

export function reportSchemaWarnings(kind, warnings, logger = console.warn) {
  if (!warnings.length) return;
  logger(`[schema:${kind}] ${warnings.length} warning(s): ${warnings.map((item) => `${item.path}: ${item.message}`).join("; ")}`);
}

export function validateDbJson(kind, data, basePath = kind) {
  if (kind === "bankIndex") return validateBankIndex(data, basePath);
  if (kind === "metadata") return validateMetadata(data, basePath);
  if (kind === "question") return validateQuestion(data, basePath);
  return [warning(basePath, `Schema kind tidak dikenal: ${kind}`)];
}

export async function readJsonValidated(filePath, kind) {
  const data = JSON.parse(await readFile(filePath, "utf-8"));
  reportSchemaWarnings(kind, validateDbJson(kind, data, filePath));
  return data;
}

export async function writeJsonValidated(filePath, data, kind) {
  reportSchemaWarnings(kind, validateDbJson(kind, data, filePath));
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  return data;
}

export async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
