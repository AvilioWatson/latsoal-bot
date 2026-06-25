import {canonicalTopic} from "../lib/paths.js";
import {requestError} from "../lib/route-utils.js";
import {runGenerator} from "../lib/runner.js";
import {TOPICS} from "../lib/taxonomy.js";

const LEVELS = new Set(["mudah", "sedang", "sulit"]);
const MODES = new Set(["auto", "gemini", "draft"]);
const PROVIDERS = new Set(["gemini", "kimi"]);
const AUTO_COUNTS = new Set([5, 10, 15]);
const DEFAULT_AUTO_TOKEN_ESTIMATE = 12000;

export {TOPICS};

export function normalizeGeneratePayload(payload) {
  const raw = payload && typeof payload === "object" ? payload : {};
  const mapel = raw.mapel || "Penalaran Umum";
  if (!Object.hasOwn(TOPICS, mapel)) {
    throw requestError(400, "Subtes tidak valid.");
  }

  const topik = canonicalTopic(mapel, raw.topik || TOPICS[mapel][0]);
  if (!TOPICS[mapel].includes(topik)) {
    throw requestError(400, "Topik tidak tersedia untuk subtes terpilih.");
  }

  const level = raw.level || "sedang";
  if (!LEVELS.has(level)) {
    throw requestError(400, "Level tidak valid.");
  }

  const mode = raw.mode || "auto";
  if (!MODES.has(mode)) {
    throw requestError(400, "Mode generator tidak valid.");
  }

  const provider = raw.provider || "gemini";
  if (!PROVIDERS.has(provider)) {
    throw requestError(400, "Provider AI tidak valid.");
  }

  const account = raw.account || "@utbk_neareducation";
  if (typeof account !== "string" || account.length > 80) {
    throw requestError(400, "Account harus berupa teks maksimal 80 karakter.");
  }

  return {mapel, topik, level, mode, provider, account};
}

function normalizeSharedOptions(raw) {
  const mapel = raw.mapel || "Penalaran Umum";
  if (!Object.hasOwn(TOPICS, mapel)) {
    throw requestError(400, "Subtes tidak valid.");
  }

  const level = raw.level || "sedang";
  if (!LEVELS.has(level)) {
    throw requestError(400, "Level tidak valid.");
  }

  const mode = raw.mode || "auto";
  if (!MODES.has(mode)) {
    throw requestError(400, "Mode generator tidak valid.");
  }

  const provider = raw.provider || "gemini";
  if (!PROVIDERS.has(provider)) {
    throw requestError(400, "Provider AI tidak valid.");
  }

  const account = raw.account || "@utbk_neareducation";
  if (typeof account !== "string" || account.length > 80) {
    throw requestError(400, "Account harus berupa teks maksimal 80 karakter.");
  }

  return {mapel, level, mode, provider, account};
}

export function normalizeAutoGeneratePayload(payload) {
  const raw = payload && typeof payload === "object" ? payload : {};
  const shared = normalizeSharedOptions(raw);
  const count = Number(raw.count || 5);
  if (!Number.isInteger(count) || !AUTO_COUNTS.has(count)) {
    throw requestError(400, "Jumlah auto generator harus 5, 10, atau 15 soal.");
  }

  return {...shared, count};
}

export function autoTokenPlan(requestedCount, raw = {}) {
  const explicitBudget = Number(raw.token_budget ?? process.env.AUTO_GENERATOR_TOKEN_BUDGET ?? 0);
  const estimatePerQuestion = Number(
    raw.estimated_tokens_per_question
    ?? process.env.AUTO_GENERATOR_ESTIMATED_TOKENS_PER_QUESTION
    ?? DEFAULT_AUTO_TOKEN_ESTIMATE,
  );

  if (!Number.isFinite(explicitBudget) || explicitBudget <= 0) {
    return {
      plannedCount: requestedCount,
      tokenLimited: false,
      estimatedTokensPerQuestion: estimatePerQuestion,
      tokenBudget: null,
      preflightLimited: false,
    };
  }

  const safeEstimate = Number.isFinite(estimatePerQuestion) && estimatePerQuestion > 0
    ? estimatePerQuestion
    : DEFAULT_AUTO_TOKEN_ESTIMATE;

  return {
    plannedCount: requestedCount,
    tokenLimited: false,
    estimatedTokensPerQuestion: safeEstimate,
    tokenBudget: explicitBudget,
    preflightLimited: false,
  };
}

function randomTopic(mapel) {
  const topics = TOPICS[mapel] || [];
  return topics[Math.floor(Math.random() * topics.length)] || "";
}

function isTokenOrQuotaError(error) {
  const text = [
    error?.message,
    error?.payload?.error,
    error?.payload?.detail,
    error?.payload?.reason,
  ].filter(Boolean).join(" ").toLowerCase();

  return /quota|token|429|rate limit|max_tokens|maxoutputtokens/.test(text);
}

function batchMessage({requestedCount, plannedCount, generatedCount, tokenLimited, stoppedByQuota, actualTokenLimited}) {
  if (generatedCount === requestedCount) {
    return `Auto generator selesai membuat ${generatedCount} soal.`;
  }

  if (stoppedByQuota) {
    return `Token atau kuota provider tidak cukup. Hanya bisa membuat ${generatedCount} dari ${requestedCount} soal.`;
  }

  if (tokenLimited) {
    if (actualTokenLimited) {
      return `Token yang tersedia berdasarkan pemakaian aktual hanya cukup untuk ${generatedCount} dari ${requestedCount} soal.`;
    }
    return `Token yang tersedia hanya cukup untuk ${plannedCount} dari ${requestedCount} soal.`;
  }

  return `Auto generator membuat ${generatedCount} dari ${requestedCount} soal.`;
}

function totalAiTokens(result) {
  return Number(result?.ai_usage?.total_tokens || result?.usage?.total_tokens || 0);
}

export async function generateAutoBatchFromPayload(payload) {
  const normalized = normalizeAutoGeneratePayload(payload);
  const plan = autoTokenPlan(normalized.count, payload && typeof payload === "object" ? payload : {});

  if (plan.plannedCount < 1) {
    throw requestError(400, "Token generator tidak cukup untuk membuat soal.");
  }

  const results = [];
  const failures = [];
  let stoppedByQuota = false;
  let actualTokenLimited = false;
  let actualTokenUsage = 0;

  for (let index = 0; index < plan.plannedCount; index += 1) {
    const itemPayload = {
      ...normalized,
      topik: randomTopic(normalized.mapel),
    };
    delete itemPayload.count;

    try {
      const result = await runGenerator(itemPayload);
      results.push(result);
      const usedTokens = totalAiTokens(result);
      actualTokenUsage += usedTokens;
      if (plan.tokenBudget && usedTokens > 0) {
        const averageTokens = Math.ceil(actualTokenUsage / results.length);
        if (index + 1 < plan.plannedCount && actualTokenUsage + averageTokens > plan.tokenBudget) {
          actualTokenLimited = true;
          break;
        }
      }
    } catch (error) {
      failures.push({
        index,
        mapel: itemPayload.mapel,
        topik: itemPayload.topik,
        error: error?.payload?.detail || error?.payload?.error || error.message,
      });
      stoppedByQuota = isTokenOrQuotaError(error);
      if (stoppedByQuota && results.length > 0) break;
      throw error;
    }
  }

  const generatedCount = results.length;
  return {
    ok: true,
    mode: "auto_batch",
    requested_count: normalized.count,
    planned_count: plan.plannedCount,
    generated_count: generatedCount,
    token_limited: plan.tokenLimited || stoppedByQuota || actualTokenLimited,
    estimated_tokens_per_question: plan.estimatedTokensPerQuestion,
    token_budget: plan.tokenBudget,
    actual_token_usage: actualTokenUsage,
    message: batchMessage({
      requestedCount: normalized.count,
      plannedCount: plan.plannedCount,
      generatedCount,
      tokenLimited: plan.tokenLimited || actualTokenLimited,
      stoppedByQuota,
      actualTokenLimited,
    }),
    results,
    last_result: results[results.length - 1] || null,
    failures,
  };
}

export async function generateFromPayload(payload) {
  return runGenerator(normalizeGeneratePayload(payload));
}
