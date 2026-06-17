import {spawnSync} from "node:child_process";
import {readFileSync, readdirSync, rmSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {validateGeneratorOutput} from "../lib/validator.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON = process.env.PYTHON || "python";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: "pipe",
    windowsHide: true,
    ...options,
  });

  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
  }

  return result;
}

function gitTrackedFiles() {
  return run("git", ["ls-files"]).stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitProjectFiles() {
  const tracked = gitTrackedFiles();
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"]).stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])];
}

function listJsFiles() {
  const files = ["server.js"];
  for (const dir of ["lib", "routes", "frontend"]) {
    for (const entry of readdirSync(path.join(ROOT, dir), {withFileTypes: true})) {
      if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files;
}

function listTestFiles() {
  return readdirSync(path.join(ROOT, "tests"), {withFileTypes: true})
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => path.join("tests", entry.name));
}

function listJsonFiles() {
  const files = [path.join("config", "topics.json"), path.join("config", "patterns.json")];
  for (const entry of readdirSync(path.join(ROOT, "bank_soal", "patterns"), {withFileTypes: true})) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path.join("bank_soal", "patterns", entry.name));
    }
  }
  return files;
}

function listPythonTestFiles() {
  return readdirSync(path.join(ROOT, "tests"), {withFileTypes: true})
    .filter((entry) => entry.isFile() && entry.name.startsWith("test_") && entry.name.endsWith(".py"))
    .map((entry) => path.join("tests", entry.name));
}

function checkTrackedRuntimeData(files) {
  const blocked = files.filter((file) => (
    (file === ".env" || (file.startsWith(".env.") && file !== ".env.example"))
    || file.startsWith("outputs/")
    || file.startsWith("saved/")
    || file.startsWith("approved/")
    || file === "bank/index.json"
  ));
  if (blocked.length > 0) {
    throw new Error(`Runtime/local files are tracked by git:\n${blocked.join("\n")}`);
  }
}

function checkTrackedSecrets(files) {
  const allowed = new Set([".env.example"]);
  const findings = [];
  const secretPatterns = [
    /AIza[0-9A-Za-z_-]{20,}/,
    /GEMINI_API_KEY\s*=\s*["']?(?!isi_api_key|$)[^\s#"']{12,}/,
    /(api[_-]?key|secret|token)\s*[:=]\s*["']?(?!isi_|example|placeholder|dummy|test)[0-9A-Za-z._~+/=-]{20,}/i,
  ];

  for (const file of files) {
    if (allowed.has(file)) continue;
    const fullPath = path.join(ROOT, file);
    let text = "";
    try {
      text = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (secretPatterns.some((pattern) => pattern.test(line))) {
        findings.push(`${file}:${index + 1}`);
      }
    });
  }

  if (findings.length > 0) {
    throw new Error(`Potential secrets found in tracked files:\n${findings.join("\n")}`);
  }
}

function checkApiDocs() {
  const apiDoc = readFileSync(path.join(ROOT, "API.md"), "utf-8");
  const requiredRoutes = [
    "GET /config",
    "POST /generate",
    "POST /saved",
    "GET /saved",
    "GET /saved/<run-id>",
    "POST /saved/<run-id>/status",
    "DELETE /saved/<run-id>",
    "POST /export",
    "GET /stats",
    "GET /health",
  ];
  const missing = requiredRoutes.filter((route) => !apiDoc.includes(route));
  if (missing.length > 0) {
    throw new Error(`API.md missing route contracts:\n${missing.join("\n")}`);
  }
}

function checkProjectDocs() {
  const docs = {
    "README.md": readFileSync(path.join(ROOT, "README.md"), "utf-8"),
    "QUALITY.md": readFileSync(path.join(ROOT, "QUALITY.md"), "utf-8"),
    "API.md": readFileSync(path.join(ROOT, "API.md"), "utf-8"),
  };
  const requiredFiles = [
    "API.md",
    "QUALITY.md",
    ".github/workflows/quality.yml",
    "config/topics.json",
    "config/patterns.json",
    "scripts/check.mjs",
  ];
  const missingFiles = requiredFiles.filter((file) => {
    try {
      readFileSync(path.join(ROOT, file));
      return false;
    } catch {
      return true;
    }
  });
  if (missingFiles.length > 0) {
    throw new Error(`Required project docs/config files are missing:\n${missingFiles.join("\n")}`);
  }

  const mustMention = [
    ["README.md", "npm.cmd run check"],
    ["README.md", "API.md"],
    ["README.md", "QUALITY.md"],
    ["QUALITY.md", "npm.cmd run check"],
    ["QUALITY.md", "LATSOAL_DATA_ROOT"],
    ["API.md", "POST /generate"],
  ];
  const missingMentions = mustMention.filter(([file, text]) => !docs[file].includes(text));
  if (missingMentions.length > 0) {
    throw new Error(`Required documentation mentions are missing:\n${missingMentions.map(([file, text]) => `${file}: ${text}`).join("\n")}`);
  }
}

function checkWorkflows() {
  const quality = readFileSync(path.join(ROOT, ".github", "workflows", "quality.yml"), "utf-8");
  const manual = readFileSync(path.join(ROOT, ".github", "workflows", "manual-content.yml"), "utf-8");
  const required = [
    ["quality.yml", quality, "npm run check"],
    ["quality.yml", quality, "actions/setup-node@v4"],
    ["quality.yml", quality, "actions/setup-python@v5"],
    ["manual-content.yml", manual, "npm.cmd run check"],
    ["manual-content.yml", manual, "actions/setup-node@v4"],
    ["manual-content.yml", manual, "actions/setup-python@v5"],
  ];
  const missing = required.filter(([, text, needle]) => !text.includes(needle));
  if (missing.length > 0) {
    throw new Error(`Workflow quality requirements missing:\n${missing.map(([file, , needle]) => `${file}: ${needle}`).join("\n")}`);
  }
}

function checkFrontendConfigUsage() {
  const savedJs = readFileSync(path.join(ROOT, "frontend", "saved.js"), "utf-8");
  const topics = JSON.parse(readFileSync(path.join(ROOT, "config", "topics.json"), "utf-8"));
  const hardcoded = Object.keys(topics).filter((subtest) => savedJs.includes(`"${subtest}"`));
  if (hardcoded.length > 0) {
    throw new Error(`frontend/saved.js has hardcoded subtests; load /config instead:\n${hardcoded.join("\n")}`);
  }
}

function checkLineEndings(files) {
  const textExtensions = new Set([
    ".css",
    ".html",
    ".js",
    ".json",
    ".md",
    ".mjs",
    ".py",
    ".txt",
    ".yml",
    ".yaml",
  ]);
  const checked = files
    .filter((file) => textExtensions.has(path.extname(file).toLowerCase()) || file === ".gitattributes" || file === ".gitignore")
    .filter((file) => !file.startsWith("bank_soal/patterns/"));
  const crlfFiles = checked.filter((file) => {
    try {
      return readFileSync(path.join(ROOT, file), "utf-8").includes("\r\n");
    } catch {
      return false;
    }
  });
  if (crlfFiles.length > 0) {
    throw new Error(`Tracked text files must use LF line endings:\n${crlfFiles.join("\n")}`);
  }
}

const trackedFiles = gitTrackedFiles();
const projectFiles = gitProjectFiles();
checkTrackedRuntimeData(trackedFiles);
console.log("ok git tracked runtime data check");
checkTrackedSecrets(projectFiles);
console.log("ok project secret scan");
checkApiDocs();
console.log("ok API.md route contract check");
checkProjectDocs();
console.log("ok project documentation check");
checkWorkflows();
console.log("ok workflow quality check");
checkFrontendConfigUsage();
console.log("ok frontend config usage check");
checkLineEndings(projectFiles);
console.log("ok project line endings check");

for (const file of listJsFiles()) {
  run("node", ["--check", file]);
  console.log(`ok node --check ${file}`);
}

for (const file of listJsonFiles()) {
  JSON.parse(readFileSync(path.join(ROOT, file), "utf-8"));
  console.log(`ok json ${file}`);
}

const testFiles = listTestFiles();
if (testFiles.length === 0) {
  throw new Error("No Node test files found.");
}
run("node", ["--test", ...testFiles]);
console.log("ok node --test tests");

run(PYTHON, ["-m", "py_compile", "content_generator.py"]);
console.log("ok python -m py_compile content_generator.py");

const pythonTestFiles = listPythonTestFiles();
if (pythonTestFiles.length === 0) {
  throw new Error("No Python test files found.");
}
run(PYTHON, ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"]);
console.log("ok python unittest tests");

const pythonTopics = run(PYTHON, [
  "-c",
  "import json, content_generator; print(json.dumps({'topics': content_generator.MAPEL_TOPICS, 'patterns': content_generator.PATTERN_FILES}, ensure_ascii=False))",
]);
const jsTopics = JSON.parse(readFileSync(path.join(ROOT, "config", "topics.json"), "utf-8"));
const jsPatterns = JSON.parse(readFileSync(path.join(ROOT, "config", "patterns.json"), "utf-8"));
const pythonConfig = JSON.parse(pythonTopics.stdout);
if (JSON.stringify(pythonConfig.topics) !== JSON.stringify(jsTopics)) {
  throw new Error("Python generator topics do not match config/topics.json");
}
if (JSON.stringify(pythonConfig.patterns) !== JSON.stringify(jsPatterns)) {
  throw new Error("Python generator patterns do not match config/patterns.json");
}
console.log("ok python config matches config/*.json");

const smoke = run(PYTHON, [
  "content_generator.py",
  "--mapel",
  "Penalaran Umum",
  "--topik",
  "Penalaran Deduktif",
  "--level",
  "mudah",
  "--mode",
  "draft",
  "--account",
  "@check",
], {
  env: {
    ...process.env,
    LATSOAL_RENDER_ENGINE: "pil",
  },
});

let payload;
try {
  payload = JSON.parse(smoke.stdout);
} catch (error) {
  throw new Error(`generator smoke output is not valid JSON: ${error.message}`);
}

validateGeneratorOutput(payload);
rmSync(path.join(ROOT, "outputs", payload.storage_path || payload.run_id), {recursive: true, force: true});

console.log(`ok generator smoke ${payload.run_id}`);
