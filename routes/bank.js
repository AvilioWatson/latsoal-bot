import {access, cp, mkdir, readdir, rm, writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import path from "node:path";
import {readJsonValidated, validateQuestion, writeJsonValidated} from "../lib/dbschema.js";
import {normalizeCaptionForStorage, normalizeQuestionForStorage} from "../lib/content-normalize.js";
import {
  addEntry,
  createEntryFromMetadata,
  rebuildIndex,
  readIndex,
  removeEntry,
  updateEntry,
} from "../lib/filestore.js";
import {errorStatus, readJsonBody, sendError, sendJson} from "../lib/http.js";
import {OUTPUTS, ROOT, SAVED, buildStoragePath, buildWebFiles, canonicalTopic, isValidRunId, pathFromIndexEntry, safeJoin} from "../lib/paths.js";
import {requestError, wantsJson} from "../lib/route-utils.js";
import {DEDUP_THRESHOLD, checkDuplicateAgainstSaved} from "../lib/similarity.js";
import {runSubprocess} from "../lib/subprocess.js";
import {TOPICS} from "../lib/taxonomy.js";
import {metadataQuestionCount} from "../lib/question-count.js";
import {tryoutQuestionWarnings} from "../lib/tryout-export.js";

const DEFAULT_PYTHON = process.env.PYTHON || "python";
const IMAGE_RENDER_TIMEOUT_MS = Number(process.env.IMAGE_RENDER_TIMEOUT_MS || 120000);
const EXPLANATION_REVIEW_TIMEOUT_MS = Number(process.env.EXPLANATION_REVIEW_TIMEOUT_MS || 120000);
const explanationReviewJobs = new Map();
const MERGEABLE_PASSAGE_SUBTESTS = new Set([
  "Pengetahuan dan Pemahaman Umum",
  "Pemahaman Bacaan dan Menulis",
  "Penalaran Matematika",
]);

function retargetMetadataFiles(metadata, targetDir) {
  const artifactName = (file) => String(file || "").split(/[\\/]/).pop();
  metadata.files = metadata.files || {};
  metadata.files.question = path.join(targetDir, "soal.json");
  metadata.files.caption = path.join(targetDir, "caption.txt");
  for (const key of ["image", "thumbnail", "explanation"]) {
    if (metadata.files[key]) metadata.files[key] = path.join(targetDir, artifactName(metadata.files[key]));
  }
  for (const key of ["images", "explanations"]) {
    if (Array.isArray(metadata.files[key])) {
      metadata.files[key] = metadata.files[key].map((file) => path.join(targetDir, artifactName(file)));
    }
  }
  return metadata;
}

function taxonomyState(question = {}) {
  const mapel = question?.mapel || "";
  const topik = question?.topik || "";
  if (!mapel || !Object.hasOwn(TOPICS, mapel)) {
    return {
      ok: false,
      code: "missing_subtest",
      message: "Subtes tidak ada di taxonomy.",
    };
  }
  const canonical = canonicalTopic(mapel, topik);
  if (!topik || !TOPICS[mapel].includes(canonical)) {
    return {
      ok: false,
      code: "missing_topic",
      message: "Subtopik tidak ada di taxonomy subtes ini.",
    };
  }
  return {ok: true, code: null, message: ""};
}

async function resolveSavedRun(runId) {
  if (!isValidRunId(runId)) return null;
  const index = await readIndex();
  const entry = index.find((item) => item.run_id === runId);
  const candidates = [];
  if (entry) {
    candidates.push(pathFromIndexEntry(entry, "saved"));
  }
  candidates.push(runId);
  for (const candidate of candidates) {
    const target = safeJoin(SAVED, candidate);
    if (!target) continue;
    try {
      await access(path.join(target, "metadata.json"));
      return {dir: target, artifactPath: candidate, entry};
    } catch {
      continue;
    }
  }
  return null;
}

function passageGroupKey(question = {}) {
  const passage = question?.bacaan && typeof question.bacaan === "object" ? question.bacaan : null;
  const passageId = String(passage?.id || "").trim();
  const passageText = String(passage?.teks || "").replace(/\s+/g, " ").trim();
  const mapel = String(question?.mapel || "").trim();
  if (!mapel || !passageId || !passageText) return "";
  return `${mapel}\u001f${passageId}\u001f${passageText}`;
}

function passageQuestionNumber(question = {}) {
  const passage = question?.bacaan && typeof question.bacaan === "object" ? question.bacaan : null;
  return Number(passage?.nomor_soal || 0);
}

async function loadSavedPassageGroup(runId, baseMetadata) {
  const baseQuestion = baseMetadata?.question || {};
  const key = passageGroupKey(baseQuestion);
  const expectedTotal = Number(baseQuestion?.bacaan?.total_soal || 0);
  if (!key || expectedTotal <= 1) return [];

  const index = await readIndex();
  const grouped = new Map();
  const duplicateNumbers = new Set();
  for (const entry of index) {
    if (!isValidRunId(entry.run_id)) continue;
    const artifactPath = pathFromIndexEntry(entry, "saved");
    const metadataPath = path.join(SAVED, artifactPath, "metadata.json");
    let metadata = null;
    try {
      metadata = await readJsonValidated(metadataPath, "metadata");
    } catch {
      continue;
    }
    if (passageGroupKey(metadata.question || {}) !== key) continue;
    const number = passageQuestionNumber(metadata.question || {});
    if (number < 1 || number > expectedTotal) continue;
    if (grouped.has(number)) duplicateNumbers.add(number);
    grouped.set(number, {entry, artifactPath, metadataPath, runDir: path.dirname(metadataPath), metadata});
  }

  return {
    expectedTotal,
    duplicateNumbers: [...duplicateNumbers],
    items: Array.from(grouped.entries())
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value),
  };
}

async function resolveOutputRun(runId) {
  if (!isValidRunId(runId)) return null;
  const candidates = [runId];
  async function collect(dir) {
    let names;
    try {
      names = await readdir(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const dirent of names) {
      const target = path.join(dir, dirent.name);
      if (!dirent.isDirectory()) continue;
      if (dirent.name === runId) {
        candidates.unshift(path.relative(OUTPUTS, target).replace(/\\/g, "/"));
      } else {
        await collect(target);
      }
    }
  }
  await collect(OUTPUTS);
  for (const candidate of candidates) {
    const target = safeJoin(OUTPUTS, candidate);
    if (!target) continue;
    try {
      await access(path.join(target, "metadata.json"));
      return {dir: target, artifactPath: candidate};
    } catch {
      continue;
    }
  }
  return null;
}

async function saveRun(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }

  const sourceRun = await resolveOutputRun(runId);
  if (!sourceRun) {
    throw requestError(404, "Output run tidak ditemukan.");
  }
  const metadata = await readJsonValidated(path.join(sourceRun.dir, "metadata.json"), "metadata");
  try {
    await readJsonValidated(path.join(sourceRun.dir, "soal.json"), "question");
  } catch (error) {
    console.warn(`[schema:question] ${path.join(sourceRun.dir, "soal.json")}: ${error.message}`);
  }
  if (metadata.question) metadata.question = normalizeQuestionForStorage(metadata.question);
  if (metadata.caption) metadata.caption = normalizeCaptionForStorage(metadata.question || {}, metadata.caption);
  const artifactPath = buildStoragePath(metadata.question || {}, runId);
  const target = safeJoin(SAVED, artifactPath);
  if (!target) {
    throw requestError(400, "Path run tidak valid.");
  }
  await mkdir(SAVED, {recursive: true});
  await mkdir(path.dirname(target), {recursive: true});
  await cp(sourceRun.dir, target, {recursive: true, force: true});

  const savedAt = new Date().toISOString();
  metadata.storage_path = artifactPath;
  retargetMetadataFiles(metadata, target);
  await writeJsonValidated(path.join(target, "metadata.json"), metadata, "metadata");
  if (metadata.question) {
    await writeJsonValidated(path.join(target, "soal.json"), metadata.question, "question");
  }
  if (metadata.caption) {
    const captionText = metadata.caption.caption || "";
    const hashtags = Array.isArray(metadata.caption.hashtag) ? metadata.caption.hashtag.join(" ") : "";
    await writeFile(path.join(target, "caption.txt"), `${captionText}\n\n${hashtags}\n`, "utf-8");
  }
  await addEntry(createEntryFromMetadata(runId, metadata, {
    saved_at: savedAt,
    status: "saved",
    path: `saved/${artifactPath}`,
  }));

  return {
    run_id: runId,
    saved_at: savedAt,
    saved_path: target,
    web_files: buildWebFiles("/saved", artifactPath, metadata.files),
  };
}

async function listSavedRuns() {
  const index = await rebuildIndex();
  const items = [];
  for (const item of index) {
    if (!isValidRunId(item.run_id)) continue;
    const artifactPath = pathFromIndexEntry(item, "saved");
    const metadataPath = path.join(SAVED, artifactPath, "metadata.json");
    let metadata = null;
    try {
      metadata = await readJsonValidated(metadataPath, "metadata");
    } catch {
      metadata = null;
    }
    const tryoutWarnings = metadata
      ? tryoutQuestionWarnings(metadata)
      : [{code: "missing_metadata", message: "metadata.json tidak bisa dibaca."}];
    const status = item.status || "saved";
    items.push({
      run_id: item.run_id,
      saved_at: item.saved_at || null,
      uploaded_at: item.uploaded_at || null,
      status,
      source: metadata?.source || null,
      question_count: metadata ? metadataQuestionCount(metadata) : 1,
      review_status: metadata?.review_status || null,
      dedup: metadata?.dedup || null,
      mapel: metadata?.question?.mapel || null,
      topik: metadata?.question?.topik || null,
      canonical_topik: canonicalTopic(metadata?.question?.mapel, metadata?.question?.topik) || null,
      taxonomy_state: taxonomyState(metadata?.question || {}),
      explanation_review: metadata?.explanation_review || null,
      explanation_review_job: publicExplanationReviewJob(explanationReviewJobs.get(item.run_id)),
      tryout_ready: status === "approved" && tryoutWarnings.length === 0,
      tryout_warning_count: tryoutWarnings.length,
      tryout_warnings: tryoutWarnings,
      level: metadata?.question?.level || null,
      soal_excerpt: String(metadata?.question?.soal || "").replace(/\s+/g, " ").trim().slice(0, 180),
      jawaban: metadata?.question?.jawaban || null,
      web_files: buildWebFiles("/saved", artifactPath, metadata?.files),
    });
  }
  return items;
}

async function updateSavedStatus(runId, status) {
  const allowed = new Set(["saved", "approved", "rejected"]);
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  if (!allowed.has(status)) {
    throw requestError(400, "Status tidak valid.");
  }

  const resolved = await resolveSavedRun(runId);
  if (!resolved) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  if (status === "approved") {
    const metadata = await readJsonValidated(path.join(resolved.dir, "metadata.json"), "metadata");
    if (!metadata.explanation_review?.provider_reviewed || metadata.review_status !== "ready") {
      throw requestError(409, "Soal hanya dapat di-approve setelah review provider berhasil dan diterapkan.");
    }
  }

  const now = new Date().toISOString();
  return updateEntry(runId, {
    status,
    status_updated_at: now,
    approved_at: status === "approved" ? now : null,
    rejected_at: status === "rejected" ? now : null,
  });
}

async function markSavedUploaded(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }

  const resolved = await resolveSavedRun(runId);
  if (!resolved) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const now = new Date().toISOString();
  return updateEntry(runId, {
    uploaded_at: now,
  });
}

async function unmarkSavedUploaded(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }

  const resolved = await resolveSavedRun(runId);
  if (!resolved) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  return updateEntry(runId, {
    uploaded_at: null,
  });
}

async function deleteSavedRun(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }

  const resolved = await resolveSavedRun(runId);
  const target = resolved?.dir;
  if (!target) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  await removeEntry(runId);
  await rm(target, {recursive: true, force: true});
  explanationReviewJobs.delete(runId);

  return {
    run_id: runId,
    deleted: true,
  };
}

async function runImageRenderer(metadataPath) {
  const completed = await runSubprocess(DEFAULT_PYTHON, ["content_generator.py", "--render-images", metadataPath], {
    cwd: ROOT,
    timeoutMs: IMAGE_RENDER_TIMEOUT_MS,
  });
  let parsed;
  try {
    parsed = JSON.parse(completed.stdout);
  } catch {
    throw new Error(completed.stderr || "Renderer gambar tidak mengembalikan JSON valid.");
  }
  if (completed.exitCode !== 0 || parsed.ok === false) {
    throw new Error(parsed.detail || completed.stderr || "Render gambar gagal.");
  }
  return parsed;
}

async function runExplanationReview(metadataPath, provider = "gemini") {
  const completed = await runSubprocess(DEFAULT_PYTHON, [
    "content_generator.py",
    "--review-explanation",
    metadataPath,
    "--provider",
    provider,
  ], {
    cwd: ROOT,
    timeoutMs: EXPLANATION_REVIEW_TIMEOUT_MS,
  });
  let parsed;
  try {
    parsed = JSON.parse(completed.stdout);
  } catch {
    throw new Error(completed.stderr || "Review pembahasan tidak mengembalikan JSON valid.");
  }
  if (completed.exitCode !== 0 || parsed.ok === false) {
    throw new Error(parsed.detail || completed.stderr || "Review pembahasan gagal.");
  }
  return parsed;
}

async function generateSavedImages(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  const resolved = await resolveSavedRun(runId);
  const runDir = resolved?.dir;
  const artifactPath = resolved?.artifactPath || runId;
  if (!runDir) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }
  const metadataPath = path.join(runDir, "metadata.json");
  try {
    await access(metadataPath);
  } catch {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const result = await runImageRenderer(metadataPath);
  return {
    run_id: runId,
    files: result.files,
    web_files: buildWebFiles("/saved", artifactPath, result.files),
  };
}

function publicSavedMatchPayload(match) {
  if (!match?.metadata) return null;
  return {
    run_id: match.metadata.run_id || match.run_id,
    source: match.metadata.source || "saved",
    review_status: match.metadata.review_status || null,
    question: match.metadata.question || {},
    caption: match.metadata.caption || {},
    validation: match.metadata.validation || {},
    dedup: match.metadata.dedup || null,
    canonical_topik: match.metadata.question
      ? canonicalTopic(match.metadata.question.mapel, match.metadata.question.topik)
      : null,
    web_files: buildWebFiles("/saved", match.artifactPath, match.metadata.files),
  };
}

async function recalculateSavedSimilarity(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }

  const resolved = await resolveSavedRun(runId);
  const runDir = resolved?.dir;
  const artifactPath = resolved?.artifactPath || runId;
  if (!runDir) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const metadataPath = path.join(runDir, "metadata.json");
  const metadata = await readJsonValidated(metadataPath, "metadata");
  const {dedup, match} = await checkDuplicateAgainstSaved(metadata.question || {}, {excludeRunId: runId});
  metadata.dedup = dedup;
  await writeJsonValidated(metadataPath, metadata, "metadata");

  const patchedEntry = createEntryFromMetadata(runId, metadata, {
    ...(resolved.entry || {}),
    path: `saved/${artifactPath}`,
  });
  await updateEntry(runId, patchedEntry);

  return {
    ok: true,
    run_id: runId,
    dedup,
    threshold: DEDUP_THRESHOLD,
    match: publicSavedMatchPayload(match),
  };
}

function mergePassageSource(question = {}) {
  const passage = question?.bacaan && typeof question.bacaan === "object" ? question.bacaan : null;
  if (!passage || !String(passage.teks || "").trim()) return null;
  const total = Number(passage.total_soal || 1);
  if (total > 1) return null;
  return passage;
}

async function writeMergedPassageRun(resolved, metadata) {
  const runId = metadata.run_id;
  const now = new Date().toISOString();
  metadata.question = normalizeQuestionForStorage(metadata.question);
  metadata.caption = normalizeCaptionForStorage(metadata.question, metadata.caption || {});
  metadata.review_status = "needs_review";
  metadata.dedup = null;
  delete metadata.explanation_review;
  metadata.edited_at = now;
  await writeJsonValidated(path.join(resolved.dir, "metadata.json"), metadata, "metadata");
  await writeJsonValidated(path.join(resolved.dir, "soal.json"), metadata.question, "question");
  const hashtags = Array.isArray(metadata.caption?.hashtag) ? metadata.caption.hashtag.join(" ") : "";
  await writeFile(path.join(resolved.dir, "caption.txt"), `${metadata.caption?.caption || ""}\n\n${hashtags}\n`, "utf-8");
  await deleteSavedImages(runId);
  const stored = await readJsonValidated(path.join(resolved.dir, "metadata.json"), "metadata");
  await updateEntry(runId, createEntryFromMetadata(runId, stored, {
    ...(resolved.entry || {}),
    path: `saved/${resolved.artifactPath}`,
    status: "saved",
    status_updated_at: now,
    approved_at: null,
    rejected_at: null,
  }));
  explanationReviewJobs.delete(runId);
  return stored;
}

async function mergeSavedPassageQuestions(runId, payload) {
  const otherRunId = String(payload?.other_run_id || "");
  if (!isValidRunId(runId) || !isValidRunId(otherRunId) || runId === otherRunId) {
    throw requestError(400, "Dua run ID yang berbeda dan valid diperlukan untuk menggabungkan soal.");
  }
  const [active, match] = await Promise.all([resolveSavedRun(runId), resolveSavedRun(otherRunId)]);
  if (!active || !match) throw requestError(404, "Salah satu saved run tidak ditemukan.");

  const [activeMetadata, matchMetadata] = await Promise.all([
    readJsonValidated(path.join(active.dir, "metadata.json"), "metadata"),
    readJsonValidated(path.join(match.dir, "metadata.json"), "metadata"),
  ]);
  const activeQuestion = activeMetadata.question || {};
  const matchQuestion = matchMetadata.question || {};
  if (!MERGEABLE_PASSAGE_SUBTESTS.has(activeQuestion.mapel) || activeQuestion.mapel !== matchQuestion.mapel) {
    throw requestError(409, "Gabungkan soal hanya tersedia untuk pasangan PPU, PBM, atau PM pada subtes yang sama.");
  }
  const sourcePassage = mergePassageSource(activeQuestion);
  if (!sourcePassage) {
    throw requestError(409, "Soal aktif harus memiliki satu bacaan tunggal sebelum dapat digabungkan.");
  }
  const matchPassage = matchQuestion?.bacaan && typeof matchQuestion.bacaan === "object" ? matchQuestion.bacaan : null;
  if (Number(matchPassage?.total_soal || 1) > 1) {
    throw requestError(409, "Soal pembanding sudah menjadi bagian dari paket bacaan dan tidak dapat digabungkan ulang.");
  }

  const sharedPassage = structuredClone(sourcePassage);
  sharedPassage.id = String(sharedPassage.id || `MERGED-${runId}`).trim();
  sharedPassage.total_soal = 2;
  activeMetadata.question = {
    ...activeQuestion,
    bacaan: {...sharedPassage, nomor_soal: 1},
  };
  matchMetadata.question = {
    ...matchQuestion,
    bacaan: {...sharedPassage, nomor_soal: 2},
  };
  const mergedAt = new Date().toISOString();
  for (const metadata of [activeMetadata, matchMetadata]) {
    metadata.passage_merge = {
      merged_at: mergedAt,
      source_run_id: runId,
      run_ids: [runId, otherRunId],
      total_soal: 2,
    };
  }

  const [storedActive, storedMatch] = await Promise.all([
    writeMergedPassageRun(active, activeMetadata),
    writeMergedPassageRun(match, matchMetadata),
  ]);
  return {
    ok: true,
    merged_run_ids: [runId, otherRunId],
    passage: sharedPassage,
    questions: [storedActive.question, storedMatch.question],
  };
}

async function reviewSavedExplanation(runId, provider = "gemini") {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  const resolved = await resolveSavedRun(runId);
  const runDir = resolved?.dir;
  const artifactPath = resolved?.artifactPath || runId;
  if (!runDir) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }
  const metadataPath = path.join(runDir, "metadata.json");
  let metadata;
  try {
    metadata = await readJsonValidated(metadataPath, "metadata");
  } catch {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const result = await runExplanationReview(metadataPath, provider);
  return {
    run_id: runId,
    explanation_review: result.explanation_review,
    web_files: buildWebFiles("/saved", artifactPath, metadata.files),
  };
}

function publicExplanationReviewJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    run_id: job.run_id,
    status: job.status,
    provider: job.provider,
    started_at: job.started_at,
    finished_at: job.finished_at || null,
    error: job.error || null,
    result: job.result || null,
  };
}

async function startSavedExplanationReview(runId, provider = "gemini") {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  const existing = explanationReviewJobs.get(runId);
  if (existing?.status === "running") {
    return publicExplanationReviewJob(existing);
  }

  const resolved = await resolveSavedRun(runId);
  if (!resolved) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const job = {
    id: randomUUID(),
    run_id: runId,
    status: "running",
    provider: provider === "kimi" ? "kimi" : "gemini",
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    result: null,
  };
  explanationReviewJobs.set(runId, job);

  reviewSavedExplanation(runId, job.provider)
    .then((result) => {
      job.status = "done";
      job.finished_at = new Date().toISOString();
      job.result = result;
    })
    .catch((error) => {
      job.status = "error";
      job.finished_at = new Date().toISOString();
      job.error = error.message || "Cek pembahasan gagal.";
    });

  return publicExplanationReviewJob(job);
}

function getSavedExplanationReviewJob(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  const job = explanationReviewJobs.get(runId);
  if (!job) {
    throw requestError(404, "Job cek pembahasan tidak ditemukan.");
  }
  return publicExplanationReviewJob(job);
}

async function applySavedExplanationReview(runId, payload) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  const jobId = String(payload?.job_id || "");
  const job = explanationReviewJobs.get(runId);
  if (!jobId || !job || job.id !== jobId || job.status !== "done" || !job.result?.explanation_review) {
    throw requestError(409, "Job review yang valid dan selesai diperlukan sebelum menerapkan revisi.");
  }
  const review = job.result.explanation_review;
  const revisedQuestion = review.question_revisi;
  const revisedGroup = Array.isArray(review?.question_group_revisi) ? review.question_group_revisi : null;
  if ((!revisedGroup || !revisedGroup.length) && (!revisedQuestion || typeof revisedQuestion !== "object" || Array.isArray(revisedQuestion))) {
    throw requestError(400, "Draft revisi soal tidak valid.");
  }
  if (revisedGroup?.length) {
    for (const [index, question] of revisedGroup.entries()) {
      const warnings = validateQuestion(question, `question_group_revisi[${index}]`);
      if (warnings.length) {
        throw requestError(400, `Draft revisi grup belum valid: ${warnings[0].path} ${warnings[0].message}`);
      }
    }
  } else {
    const warnings = validateQuestion(revisedQuestion, "question_revisi");
    if (warnings.length) {
      throw requestError(400, `Draft revisi belum valid: ${warnings[0].path} ${warnings[0].message}`);
    }
  }

  const resolved = await resolveSavedRun(runId);
  const runDir = resolved?.dir;
  const artifactPath = resolved?.artifactPath || runId;
  if (!runDir) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }
  const metadataPath = path.join(runDir, "metadata.json");
  const metadata = await readJsonValidated(metadataPath, "metadata");
  const {question_revisi: _ignoredQuestion, question_group_revisi: _ignoredGroup, ...reviewSummary} = review;
  const now = new Date().toISOString();
  if (revisedGroup?.length) {
    const group = await loadSavedPassageGroup(runId, metadata);
    const groupItems = group.items;
    const revisionsByNumber = new Map(revisedGroup.map((question) => [passageQuestionNumber(question), question]));
    const expectedNumbers = Array.from({length: group.expectedTotal}, (_, index) => index + 1);
    const hasCompleteItems = groupItems.length === group.expectedTotal
      && expectedNumbers.every((number) => groupItems.some((item) => passageQuestionNumber(item.metadata.question || {}) === number));
    const hasCompleteRevisions = revisedGroup.length === group.expectedTotal
      && revisionsByNumber.size === group.expectedTotal
      && expectedNumbers.every((number) => revisionsByNumber.has(number));
    if (!hasCompleteItems || !hasCompleteRevisions || group.duplicateNumbers.length) {
      throw requestError(409, "Grup bacaan tidak lengkap atau memiliki nomor soal duplikat; revisi tidak diterapkan.");
    }
    const updatedRunIds = [];
    for (const [index, groupItem] of groupItems.entries()) {
      const number = passageQuestionNumber(groupItem.metadata.question || {});
      const revised = revisionsByNumber.get(number) || revisedGroup[index];
      if (!revised) continue;
      groupItem.metadata.question = normalizeQuestionForStorage(revised);
      if (groupItem.metadata.caption) {
        groupItem.metadata.caption = normalizeCaptionForStorage(groupItem.metadata.question, groupItem.metadata.caption);
      }
      groupItem.metadata.explanation_review = {
        ...reviewSummary,
        pembahasan_revisi: groupItem.metadata.question.pembahasan,
        group_applied: true,
        group_question_count: revisedGroup.length,
        applied_at: now,
      };
      groupItem.metadata.review_status = reviewSummary.provider_reviewed && reviewSummary.lolos ? "ready" : "needs_review";
      groupItem.metadata.edited_at = now;
      await writeJsonValidated(groupItem.metadataPath, groupItem.metadata, "metadata");
      await writeJsonValidated(path.join(groupItem.runDir, "soal.json"), groupItem.metadata.question, "question");
      const patchedEntry = createEntryFromMetadata(groupItem.entry.run_id, groupItem.metadata, {
        ...(groupItem.entry || {}),
        path: `saved/${groupItem.artifactPath}`,
        status: "saved",
        status_updated_at: now,
        approved_at: null,
        rejected_at: null,
      });
      await updateEntry(groupItem.entry.run_id, patchedEntry);
      updatedRunIds.push(groupItem.entry.run_id);
      explanationReviewJobs.delete(groupItem.entry.run_id);
    }
    return {
      ok: true,
      run_id: runId,
      updated_run_ids: updatedRunIds,
      group_question_count: updatedRunIds.length,
      question: revisionsByNumber.get(passageQuestionNumber(metadata.question || {})) || revisedGroup[0],
      explanation_review: {
        ...reviewSummary,
        group_applied: true,
        group_question_count: revisedGroup.length,
        applied_at: now,
      },
      review_status: reviewSummary.provider_reviewed && reviewSummary.lolos ? "ready" : "needs_review",
      web_files: buildWebFiles("/saved", artifactPath, metadata.files),
    };
  }

  metadata.question = normalizeQuestionForStorage(revisedQuestion);
  if (metadata.caption) metadata.caption = normalizeCaptionForStorage(metadata.question, metadata.caption);
  metadata.explanation_review = {
    ...reviewSummary,
    pembahasan_revisi: metadata.question.pembahasan,
    applied_at: now,
  };
  metadata.review_status = reviewSummary.provider_reviewed && reviewSummary.lolos ? "ready" : "needs_review";
  metadata.edited_at = now;
  await writeJsonValidated(metadataPath, metadata, "metadata");
  await writeJsonValidated(path.join(runDir, "soal.json"), metadata.question, "question");
  explanationReviewJobs.delete(runId);

  const patchedEntry = createEntryFromMetadata(runId, metadata, {
    ...(resolved.entry || {}),
    path: `saved/${artifactPath}`,
    status: "saved",
    status_updated_at: now,
    approved_at: null,
    rejected_at: null,
  });
  await updateEntry(runId, patchedEntry);
  return {
    ok: true,
    run_id: runId,
    question: metadata.question,
    explanation_review: metadata.explanation_review,
    review_status: metadata.review_status,
    web_files: buildWebFiles("/saved", artifactPath, metadata.files),
  };
}

async function deleteSavedImages(runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  const resolved = await resolveSavedRun(runId);
  const runDir = resolved?.dir;
  const artifactPath = resolved?.artifactPath || runId;
  if (!runDir) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }
  const metadataPath = path.join(runDir, "metadata.json");
  let metadata;
  try {
    metadata = await readJsonValidated(metadataPath, "metadata");
  } catch {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const imageFiles = new Set([
    metadata?.files?.thumbnail,
    metadata?.files?.image,
    metadata?.files?.explanation,
    ...(Array.isArray(metadata?.files?.images) ? metadata.files.images : []),
    ...(Array.isArray(metadata?.files?.explanations) ? metadata.files.explanations : []),
  ].filter(Boolean));
  for (const name of await readdir(runDir)) {
    if (/^(?:\d+\.jpe?g|thumbnail\.(?:png|jpe?g|tex|pdf|aux|log)|post-\d+\.(?:png|jpe?g|tex|pdf|aux|log)|pembahasan-\d+\.(?:jpe?g|tex|pdf|aux|log))$/i.test(name)) {
      imageFiles.add(name);
    }
  }
  for (const imageFile of imageFiles) {
    const target = safeJoin(runDir, path.basename(String(imageFile)));
    if (target) {
      await rm(target, {force: true});
    }
  }
  metadata.files = metadata.files || {};
  delete metadata.files.thumbnail;
  delete metadata.files.image;
  delete metadata.files.explanation;
  metadata.files.images = [];
  metadata.files.explanations = [];
  metadata.image_deleted_at = new Date().toISOString();
  await writeJsonValidated(metadataPath, metadata, "metadata");

  return {
    run_id: runId,
    files: metadata.files,
    web_files: buildWebFiles("/saved", artifactPath, metadata.files),
  };
}

async function sendSavedMetadata(response, runId) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  const resolved = await resolveSavedRun(runId);
  const runDir = resolved?.dir;
  const artifactPath = resolved?.artifactPath || runId;
  if (!runDir) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }
  let metadata;
  try {
    metadata = await readJsonValidated(path.join(runDir, "metadata.json"), "metadata");
  } catch {
    throw requestError(404, "Saved run tidak ditemukan.");
  }
  metadata.web_files = buildWebFiles("/saved", artifactPath, metadata.files);
  if (metadata.question) metadata.canonical_topik = canonicalTopic(metadata.question.mapel, metadata.question.topik);
  sendJson(response, metadata);
}

async function updateSavedMetadataJson(runId, metadata) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw requestError(400, "Metadata harus berupa JSON object.");
  }
  if (metadata.run_id && metadata.run_id !== runId) {
    throw requestError(400, "run_id metadata tidak boleh berbeda dari URL.");
  }

  const resolved = await resolveSavedRun(runId);
  const runDir = resolved?.dir;
  const artifactPath = resolved?.artifactPath || runId;
  if (!runDir) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const nextMetadata = {
    ...metadata,
    run_id: runId,
    storage_path: artifactPath,
    edited_at: new Date().toISOString(),
  };
  if (nextMetadata.question) {
    nextMetadata.question = normalizeQuestionForStorage(nextMetadata.question);
  }
  if (nextMetadata.caption) {
    nextMetadata.caption = normalizeCaptionForStorage(nextMetadata.question || {}, nextMetadata.caption);
  }
  retargetMetadataFiles(nextMetadata, runDir);
  await writeJsonValidated(path.join(runDir, "metadata.json"), nextMetadata, "metadata");
  if (nextMetadata.question) {
    await writeJsonValidated(path.join(runDir, "soal.json"), nextMetadata.question, "question");
  }
  if (nextMetadata.caption) {
    const captionText = nextMetadata.caption.caption || "";
    const hashtags = Array.isArray(nextMetadata.caption.hashtag) ? nextMetadata.caption.hashtag.join(" ") : "";
    await writeFile(path.join(runDir, "caption.txt"), `${captionText}\n\n${hashtags}\n`, "utf-8");
  }

  const patchedEntry = createEntryFromMetadata(runId, nextMetadata, {
    ...(resolved.entry || {}),
    path: `saved/${artifactPath}`,
  });
  await updateEntry(runId, patchedEntry);
  return {
    ok: true,
    run_id: runId,
    metadata: {
      ...nextMetadata,
      web_files: buildWebFiles("/saved", artifactPath, nextMetadata.files),
      canonical_topik: nextMetadata.question
        ? canonicalTopic(nextMetadata.question.mapel, nextMetadata.question.topik)
        : null,
    },
  };
}

async function updateSavedClassification(runId, payload = {}) {
  if (!isValidRunId(runId)) {
    throw requestError(400, "Run ID tidak valid.");
  }
  const mapel = String(payload.mapel || "").trim();
  const topik = String(payload.topik || "").trim();
  if (!mapel || !Object.hasOwn(TOPICS, mapel)) {
    throw requestError(400, "Subtes tidak valid.");
  }
  const canonical = canonicalTopic(mapel, topik);
  if (!topik || !TOPICS[mapel].includes(canonical)) {
    throw requestError(400, "Subtopik tidak tersedia untuk subtes terpilih.");
  }

  const resolved = await resolveSavedRun(runId);
  const runDir = resolved?.dir;
  const artifactPath = resolved?.artifactPath || runId;
  if (!runDir) {
    throw requestError(404, "Saved run tidak ditemukan.");
  }

  const metadataPath = path.join(runDir, "metadata.json");
  const metadata = await readJsonValidated(metadataPath, "metadata");
  metadata.question = normalizeQuestionForStorage({
    ...(metadata.question || {}),
    mapel,
    topik: canonical,
  });
  if (metadata.caption) {
    metadata.caption = normalizeCaptionForStorage(metadata.question, metadata.caption);
  }
  metadata.edited_at = new Date().toISOString();
  await writeJsonValidated(metadataPath, metadata, "metadata");
  await writeJsonValidated(path.join(runDir, "soal.json"), metadata.question, "question");
  if (metadata.caption) {
    const captionText = metadata.caption.caption || "";
    const hashtags = Array.isArray(metadata.caption.hashtag) ? metadata.caption.hashtag.join(" ") : "";
    await writeFile(path.join(runDir, "caption.txt"), `${captionText}\n\n${hashtags}\n`, "utf-8");
  }

  const patchedEntry = createEntryFromMetadata(runId, metadata, {
    ...(resolved.entry || {}),
    path: `saved/${artifactPath}`,
  });
  await updateEntry(runId, patchedEntry);
  return {
    ok: true,
    run_id: runId,
    question: metadata.question,
    caption: metadata.caption,
    canonical_topik: canonicalTopic(metadata.question.mapel, metadata.question.topik),
    taxonomy_state: taxonomyState(metadata.question),
    web_files: buildWebFiles("/saved", artifactPath, metadata.files),
  };
}

function savedRunRoute(route) {
  const parts = route.split("/").filter(Boolean);
  if (parts[0] !== "saved" || parts.length < 2) return null;
  return isValidRunId(parts[1]) ? parts : null;
}

export async function handle(request, response, route) {
  if (request.method === "POST" && (route === "/api/save" || route === "/saved")) {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await saveRun(payload.run_id || ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (
    request.method === "GET"
    && (route === "/api/saved" || (route === "/saved" && wantsJson(request)))
  ) {
    try {
      sendJson(response, {items: await listSavedRuns()});
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  const savedRoute = savedRunRoute(route);
  if (request.method === "GET" && savedRoute?.length === 2 && wantsJson(request)) {
    try {
      await sendSavedMetadata(response, savedRoute[1]);
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "GET" && route.startsWith("/api/saved/")) {
    try {
      await sendSavedMetadata(response, route.replace("/api/saved/", ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "PUT" && savedRoute?.length === 3 && savedRoute[2] === "json") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await updateSavedMetadataJson(savedRoute[1], payload));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "classification") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await updateSavedClassification(savedRoute[1], payload));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "status") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await updateSavedStatus(savedRoute[1], payload.status || ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "uploaded") {
    try {
      sendJson(response, await markSavedUploaded(savedRoute[1]));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "unuploaded") {
    try {
      sendJson(response, await unmarkSavedUploaded(savedRoute[1]));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "images") {
    try {
      sendJson(response, await generateSavedImages(savedRoute[1]));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "similarity") {
    try {
      sendJson(response, await recalculateSavedSimilarity(savedRoute[1]));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "merge-passage") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await mergeSavedPassageQuestions(savedRoute[1], payload));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "explanation-review") {
    try {
      const payload = await readJsonBody(request).catch(() => ({}));
      sendJson(response, await startSavedExplanationReview(savedRoute[1], payload.provider || "gemini"), 202);
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (
    request.method === "GET"
    && savedRoute?.length === 4
    && savedRoute[2] === "explanation-review"
    && savedRoute[3] === "status"
  ) {
    try {
      sendJson(response, getSavedExplanationReviewJob(savedRoute[1]));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (
    request.method === "POST"
    && savedRoute?.length === 4
    && savedRoute[2] === "explanation-review"
    && savedRoute[3] === "apply"
  ) {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await applySavedExplanationReview(savedRoute[1], payload));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (
    (request.method === "DELETE" && savedRoute?.length === 3 && savedRoute[2] === "images")
    || (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "delete-images")
  ) {
    try {
      sendJson(response, await deleteSavedImages(savedRoute[1]));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && route === "/api/saved/status") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await updateSavedStatus(payload.run_id || "", payload.status || ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (
    (request.method === "DELETE" && savedRoute?.length === 2)
    || (request.method === "POST" && savedRoute?.length === 3 && savedRoute[2] === "delete")
  ) {
    try {
      sendJson(response, await deleteSavedRun(savedRoute[1]));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && route === "/api/saved/delete") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await deleteSavedRun(payload.run_id || ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && route === "/api/saved/uploaded") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await markSavedUploaded(payload.run_id || ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "POST" && route === "/api/saved/unuploaded") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await unmarkSavedUploaded(payload.run_id || ""));
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  return false;
}
