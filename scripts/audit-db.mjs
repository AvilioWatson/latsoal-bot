import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {
  compatibleMapel,
  fileExists,
  validateBankIndex,
  validateMetadata,
  validateQuestion,
} from "../lib/dbschema.js";
import {DATA_ROOT, SAVED, pathFromIndexEntry} from "../lib/paths.js";

const INDEX_PATH = path.join(DATA_ROOT, "bank", "index.json");

function finding(type, target, message, extra = {}) {
  return {type, target, message, ...extra};
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf-8"));
}

async function collectMetadataFiles(dir) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (entry.isFile() && entry.name === "metadata.json") {
        files.push(target);
      }
    }
  }
  await walk(dir);
  return files;
}

function artifactName(file) {
  return String(file || "").split(/[\\/]/).pop();
}

async function auditImageRefs(metadataPath, metadata) {
  const findings = [];
  const runDir = path.dirname(metadataPath);
  const files = metadata?.files || {};
  const refs = [
    files.image,
    files.thumbnail,
    files.explanation,
    ...(Array.isArray(files.images) ? files.images : []),
    ...(Array.isArray(files.explanations) ? files.explanations : []),
  ].filter(Boolean);
  for (const ref of new Set(refs)) {
    const target = path.join(runDir, artifactName(ref));
    if (!(await fileExists(target))) {
      findings.push(finding("broken_image_ref", metadataPath, `Image ref tidak ditemukan: ${artifactName(ref)}`, {ref}));
    }
  }
  return findings;
}

async function audit() {
  const findings = [];
  let index = [];
  try {
    index = await readJson(INDEX_PATH);
    for (const item of validateBankIndex(index, INDEX_PATH)) {
      findings.push(finding("schema_warning", item.path, item.message));
    }
  } catch {
    index = [];
  }

  const paths = new Map();
  for (const entry of Array.isArray(index) ? index : []) {
    const entryPath = entry.path || `saved/${entry.run_id}`;
    if (paths.has(entryPath)) {
      findings.push(finding("duplicate_path", entryPath, "Path duplikat di bank/index.json.", {
        run_ids: [paths.get(entryPath), entry.run_id],
      }));
    } else {
      paths.set(entryPath, entry.run_id);
    }
    const metadataPath = path.join(SAVED, pathFromIndexEntry(entry, "saved"), "metadata.json");
    if (!(await fileExists(metadataPath))) {
      findings.push(finding("missing_metadata", metadataPath, "Index mengarah ke metadata.json yang tidak ada.", {run_id: entry.run_id}));
    }
  }

  const metadataFiles = await collectMetadataFiles(SAVED);
  for (const metadataPath of metadataFiles) {
    let metadata;
    try {
      metadata = await readJson(metadataPath);
    } catch (error) {
      findings.push(finding("invalid_json", metadataPath, error.message));
      continue;
    }
    for (const item of validateMetadata(metadata, metadataPath)) {
      findings.push(finding("schema_warning", item.path, item.message));
    }
    const mapel = metadata?.question?.mapel;
    const compatible = compatibleMapel(mapel);
    if (compatible && compatible !== mapel) {
      findings.push(finding("legacy_mapel", metadataPath, `Mapel legacy '${mapel}' dibaca kompatibel sebagai '${compatible}'.`, {
        mapel,
        compatible_mapel: compatible,
      }));
    }
    findings.push(...await auditImageRefs(metadataPath, metadata));

    const soalPath = path.join(path.dirname(metadataPath), "soal.json");
    if (await fileExists(soalPath)) {
      try {
        const question = await readJson(soalPath);
        for (const item of validateQuestion(question, soalPath)) {
          findings.push(finding("schema_warning", item.path, item.message));
        }
      } catch (error) {
        findings.push(finding("invalid_json", soalPath, error.message));
      }
    }
  }

  return {
    ok: findings.length === 0,
    data_root: DATA_ROOT,
    checked: {
      index_entries: Array.isArray(index) ? index.length : 0,
      metadata_files: metadataFiles.length,
    },
    findings,
  };
}

const report = await audit();
console.log(JSON.stringify(report, null, 2));
if (!report.ok && process.argv.includes("--fail-on-findings")) {
  process.exitCode = 1;
}
