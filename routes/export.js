import {access, cp, mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {readIndex, writeIndex} from "../lib/filestore.js";
import {errorStatus, sendError, sendJson} from "../lib/http.js";
import {APPROVED, SAVED, isValidRunId} from "../lib/paths.js";

async function exportApprovedRuns() {
  const index = await readIndex();
  const approved = index.filter((item) => item.status === "approved" && isValidRunId(item.run_id));
  const exportId = new Date().toISOString().replace(/[:.]/g, "-");
  const exportedAt = new Date().toISOString();
  const targetDir = path.join(APPROVED, exportId);
  await mkdir(targetDir, {recursive: true});

  const manifest = [];
  for (const item of approved) {
    const sourceDir = path.join(SAVED, item.run_id);
    const destinationDir = path.join(targetDir, item.run_id);
    try {
      await access(path.join(sourceDir, "metadata.json"));
      await cp(sourceDir, destinationDir, {recursive: true, force: true});
      const metadata = JSON.parse(await readFile(path.join(sourceDir, "metadata.json"), "utf-8"));
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
        metadata_file: `${item.run_id}/metadata.json`,
        web_files: {
          metadata: `/approved/${exportId}/${item.run_id}/metadata.json`,
          question: `/approved/${exportId}/${item.run_id}/soal.json`,
          caption: `/approved/${exportId}/${item.run_id}/caption.txt`,
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

export async function handle(request, response, route) {
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
