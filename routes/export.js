import {access, cp, mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {readJsonValidated} from "../lib/dbschema.js";
import {readIndex, writeIndex} from "../lib/filestore.js";
import {errorStatus, sendError, sendJson} from "../lib/http.js";
import {APPROVED, SAVED, isValidRunId, pathFromIndexEntry} from "../lib/paths.js";
import {artifactName} from "../lib/route-utils.js";
import {TRYOUT_EXPORT_FILENAME, TRYOUT_EXPORT_SCHEMA_VERSION, metadataToTryoutQuestions} from "../lib/tryout-export.js";

async function exportApprovedRuns() {
  const index = await readIndex();
  const approved = index.filter((item) => item.status === "approved" && isValidRunId(item.run_id));
  const exportId = new Date().toISOString().replace(/[:.]/g, "-");
  const exportedAt = new Date().toISOString();
  const targetDir = path.join(APPROVED, exportId);
  await mkdir(targetDir, {recursive: true});

  const manifest = [];
  for (const item of approved) {
    const sourceDir = path.join(SAVED, pathFromIndexEntry(item, "saved"));
    const destinationDir = path.join(targetDir, item.run_id);
    try {
      await access(path.join(sourceDir, "metadata.json"));
      await cp(sourceDir, destinationDir, {recursive: true, force: true});
      const metadata = await readJsonValidated(path.join(sourceDir, "metadata.json"), "metadata");
      manifest.push({
        run_id: item.run_id,
        saved_at: item.saved_at || null,
        status_updated_at: item.status_updated_at || item.approved_at || null,
        approved_at: item.approved_at || null,
        mapel: metadata?.question?.mapel || null,
        topik: metadata?.question?.topik || null,
        level: metadata?.question?.level || null,
        jawaban: metadata?.question?.jawaban || null,
        question_file: `${item.run_id}/soal.json`,
        caption_file: `${item.run_id}/caption.txt`,
        image_files: Array.isArray(metadata?.files?.images)
          ? metadata.files.images.map((file) => `${item.run_id}/${artifactName(file)}`)
          : [],
        metadata_file: `${item.run_id}/metadata.json`,
        web_files: {
          metadata: `/approved/${exportId}/${item.run_id}/metadata.json`,
          question: `/approved/${exportId}/${item.run_id}/soal.json`,
          caption: `/approved/${exportId}/${item.run_id}/caption.txt`,
          images: Array.isArray(metadata?.files?.images)
            ? metadata.files.images.map((file) => `/approved/${exportId}/${item.run_id}/${artifactName(file)}`)
            : [],
        },
      });
    } catch {
      continue;
    }
  }

  await writeFile(path.join(targetDir, "manifest.json"), JSON.stringify({
    export_id: exportId,
    created_at: exportedAt,
    total: manifest.length,
    items: manifest,
  }, null, 2), "utf-8");

  const exportedRunIds = new Set(manifest.map((item) => item.run_id));
  if (exportedRunIds.size > 0) {
    await writeIndex(index.map((item) => (
      exportedRunIds.has(item.run_id)
        ? {...item, exported_at: exportedAt, export_batch_id: exportId}
        : item
    )));
  }

  return {
    export_id: exportId,
    total: manifest.length,
    path: targetDir,
    manifest: `/approved/${exportId}/manifest.json`,
  };
}

async function exportTryoutQuestions() {
  const index = await readIndex();
  const approved = index.filter((item) => item.status === "approved" && isValidRunId(item.run_id));
  const exportId = new Date().toISOString().replace(/[:.]/g, "-");
  const createdAt = new Date().toISOString();
  const targetDir = path.join(APPROVED, exportId);
  await mkdir(targetDir, {recursive: true});

  const questions = [];
  const skipped = [];
  for (const item of approved) {
    const sourceDir = path.join(SAVED, pathFromIndexEntry(item, "saved"));
    const destinationDir = path.join(targetDir, item.run_id);
    try {
      await access(path.join(sourceDir, "metadata.json"));
      await cp(sourceDir, destinationDir, {recursive: true, force: true});
      const metadata = await readJsonValidated(path.join(sourceDir, "metadata.json"), "metadata");
      questions.push(...metadataToTryoutQuestions(item.run_id, metadata, exportId));
    } catch (error) {
      skipped.push({
        run_id: item.run_id,
        reason: error.message,
      });
    }
  }

  const warningCount = questions.reduce((total, question) => total + question.warnings.length, 0);
  const passageGroups = Object.values(questions.reduce((groups, question) => {
    if (!question.passage_id || !question.passage) return groups;
    const key = `${question.subtest_code || question.subtest_name || "SUB"}:${question.passage_id}`;
    groups[key] = groups[key] || {
      passage_id: question.passage_id,
      subtest_name: question.subtest_name,
      subtest_code: question.subtest_code,
      title: question.passage.judul || "",
      text: question.passage.teks || "",
      language: question.passage.bahasa || null,
      total_questions: question.passage.total_soal || null,
      question_ids: [],
    };
    groups[key].question_ids.push(question.external_id);
    return groups;
  }, {})).map((group) => ({
    ...group,
    question_ids: group.question_ids.sort((left, right) => {
      const leftQuestion = questions.find((question) => question.external_id === left);
      const rightQuestion = questions.find((question) => question.external_id === right);
      return Number(leftQuestion?.passage_order || 0) - Number(rightQuestion?.passage_order || 0);
    }),
  }));
  const payload = {
    schema_version: TRYOUT_EXPORT_SCHEMA_VERSION,
    export_id: exportId,
    created_at: createdAt,
    source_app: "latsoal-bot",
    total: questions.length,
    warning_count: warningCount,
    skipped,
    passage_groups: passageGroups,
    questions,
  };
  await writeFile(path.join(targetDir, TRYOUT_EXPORT_FILENAME), JSON.stringify(payload, null, 2), "utf-8");

  return {
    export_id: exportId,
    total: questions.length,
    warning_count: warningCount,
    file: `/approved/${exportId}/${TRYOUT_EXPORT_FILENAME}`,
    manifest: payload,
  };
}

export async function handle(request, response, route) {
  if (request.method === "POST" && route === "/api/export/tryout") {
    try {
      sendJson(response, await exportTryoutQuestions());
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method !== "POST" || (route !== "/api/export/approved" && route !== "/export")) {
    return false;
  }

  try {
    sendJson(response, await exportApprovedRuns());
  } catch (error) {
    sendError(response, errorStatus(error), error.message);
  }
  return true;
}
