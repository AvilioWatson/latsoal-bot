import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {createEntryFromMetadata, rebuildIndex} from "../lib/filestore.js";
import {OUTPUTS} from "../lib/paths.js";

const STATUS_KEYS = ["generated", "saved", "approved", "rejected"];
const LEVEL_KEYS = ["mudah", "sedang", "sulit"];
const DAY_MS = 24 * 60 * 60 * 1000;

function rate(part, total) {
  if (!total) return 0;
  return Number((part / total).toFixed(4));
}

function increment(target, key, amount = 1) {
  target[key] = (target[key] || 0) + amount;
}

function emptyProviderUsage() {
  return {
    gemini: {prompt_tokens: 0, output_tokens: 0, total_tokens: 0},
    kimi: {prompt_tokens: 0, output_tokens: 0, total_tokens: 0},
  };
}

function addProviderUsage(target, source) {
  for (const provider of ["gemini", "kimi"]) {
    target[provider].prompt_tokens += Number(source?.[provider]?.prompt_tokens || 0);
    target[provider].output_tokens += Number(source?.[provider]?.output_tokens || 0);
    target[provider].total_tokens += Number(source?.[provider]?.total_tokens || 0);
  }
}

function statusOf(entry) {
  return STATUS_KEYS.includes(entry.status) ? entry.status : "saved";
}

function entryQuestionCount(entry) {
  return Math.max(1, Number(entry?.question_count || 1));
}

function newestIso(values) {
  const latest = values
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return latest ? latest.toISOString() : null;
}

export function buildStats(entries, now = new Date()) {
  const list = Array.isArray(entries) ? entries : [];
  const total = list.reduce((sum, entry) => sum + entryQuestionCount(entry), 0);
  const byStatus = {generated: 0, saved: 0, approved: 0, rejected: 0};
  const bySubtes = {};
  const bySource = {};
  const byLevel = {mudah: 0, sedang: 0, sulit: 0};
  const tokenUsage = {
    question: emptyProviderUsage(),
    explanation: emptyProviderUsage(),
  };
  const since = now.getTime() - (7 * DAY_MS);
  const recent = [];
  const exportBatchIds = new Set();
  let duplicates = 0;
  let pendingExport = 0;

  for (const entry of list) {
    const questionCount = entryQuestionCount(entry);
    const status = statusOf(entry);
    const subtes = entry.subtes || "unknown";
    const topic = entry.topik || "unknown";
    const source = entry.source || "unknown";
    const level = entry.level || "unknown";

    increment(byStatus, status, questionCount);
    increment(bySource, source, questionCount);
    increment(byLevel, level, questionCount);
    addProviderUsage(tokenUsage.question, entry.token_usage?.question);
    addProviderUsage(tokenUsage.explanation, entry.token_usage?.explanation);

    if (!bySubtes[subtes]) {
      bySubtes[subtes] = {total: 0, saved: 0, approved: 0, rejected: 0, uploaded: 0, topics: {}};
    }
    bySubtes[subtes].total += questionCount;
    increment(bySubtes[subtes], status, questionCount);
    if (entry.uploaded_at) bySubtes[subtes].uploaded += questionCount;
    if (!bySubtes[subtes].topics[topic]) {
      bySubtes[subtes].topics[topic] = {total: 0, saved: 0, approved: 0, rejected: 0, uploaded: 0};
    }
    bySubtes[subtes].topics[topic].total += questionCount;
    increment(bySubtes[subtes].topics[topic], status, questionCount);
    if (entry.uploaded_at) bySubtes[subtes].topics[topic].uploaded += questionCount;

    if (entry.is_duplicate) duplicates += questionCount;
    if (entry.export_batch_id) exportBatchIds.add(entry.export_batch_id);
    if (status === "approved" && !entry.exported_at) pendingExport += questionCount;

    const savedAt = new Date(entry.saved_at || 0);
    if (!Number.isNaN(savedAt.getTime()) && savedAt.getTime() >= since) {
      recent.push(entry);
    }
  }

  for (const key of LEVEL_KEYS) {
    byLevel[key] = byLevel[key] || 0;
  }

  const recentTotal = recent.reduce((total, entry) => total + entryQuestionCount(entry), 0);
  const recentApproved = recent.reduce((total, entry) => total + (statusOf(entry) === "approved" ? entryQuestionCount(entry) : 0), 0);
  const recentFallback = recent.reduce((total, entry) => total + (entry.source === "fallback" ? entryQuestionCount(entry) : 0), 0);
  const fallbackRate = rate(recentFallback, recentTotal);
  const duplicateRate = rate(duplicates, total);

  const warnings = [];
  if (fallbackRate > 0.20) {
    warnings.push({
      type: "high_fallback_rate",
      message: `Fallback rate 7 hari terakhir ${Math.round(fallbackRate * 100)}% - quota Gemini mungkin sering kena`,
      severity: "warn",
    });
  }
  if (duplicateRate > 0.12) {
    warnings.push({
      type: "high_duplicate_rate",
      message: `Duplicate rate ${Math.round(duplicateRate * 100)}% - variasi topik/prompt perlu ditambah`,
      severity: "warn",
    });
  }
  for (const [subtes, row] of Object.entries(bySubtes)) {
    if (row.approved < 5) {
      warnings.push({
        type: "subtes_low_approved",
        subtes,
        message: `${subtes} hanya punya ${row.approved} soal approved`,
        severity: "info",
      });
    }
  }
  if (pendingExport >= 10) {
    warnings.push({
      type: "pending_export",
      message: `${pendingExport} soal approved belum pernah di-export`,
      severity: "info",
    });
  }

  return {
    generated_at: now.toISOString(),
    total,
    by_status: byStatus,
    by_subtes: bySubtes,
    by_source: bySource,
    by_level: byLevel,
    token_usage: tokenUsage,
    last_7_days: {
      total_generated: recentTotal,
      approved: recentApproved,
      fallback_rate: fallbackRate,
    },
    duplicate_rate: duplicateRate,
    export_batches: exportBatchIds.size,
    last_exported_at: newestIso(list.map((entry) => entry.exported_at)),
    pending_export: pendingExport,
    warnings,
  };
}

export async function readStats(now = new Date()) {
  const savedEntries = await rebuildIndex();
  const savedRunIds = new Set(savedEntries.map((entry) => entry.run_id));
  const outputEntries = await readOutputEntries(savedRunIds);
  return buildStats([...savedEntries, ...outputEntries], now);
}

async function readOutputEntries(excludedRunIds = new Set()) {
  const metadataFiles = [];

  async function collect(dir) {
    let names;
    try {
      names = await readdir(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const dirent of names) {
      const target = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await collect(target);
      } else if (dirent.isFile() && dirent.name === "metadata.json") {
        metadataFiles.push(target);
      }
    }
  }

  await collect(OUTPUTS);
  const entries = [];
  for (const metadataPath of metadataFiles) {
    const runId = path.basename(path.dirname(metadataPath));
    if (!/^\d{8}-\d{6}$/.test(runId) || excludedRunIds.has(runId)) continue;
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
      const relativeDir = path.relative(path.dirname(OUTPUTS), path.dirname(metadataPath)).replace(/\\/g, "/");
      entries.push(createEntryFromMetadata(runId, metadata, {
        status: "generated",
        path: relativeDir,
        saved_at: metadata.created_at || null,
      }));
    } catch {
      continue;
    }
  }
  return entries;
}
