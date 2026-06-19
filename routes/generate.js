import {readFileSync} from "node:fs";
import path from "node:path";
import {errorStatus, readJsonBody, sendError, sendJson} from "../lib/http.js";
import {ROOT, canonicalTopic} from "../lib/paths.js";
import {runGenerator} from "../lib/runner.js";

export const TOPICS = JSON.parse(readFileSync(path.join(ROOT, "config", "topics.json"), "utf-8"));
const LEVELS = new Set(["mudah", "sedang", "sulit"]);
const MODES = new Set(["auto", "gemini", "draft"]);
const PROVIDERS = new Set(["gemini", "kimi"]);

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeGeneratePayload(payload) {
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

export async function handle(request, response, route) {
  if (request.method === "GET" && (route === "/api/config" || route === "/config")) {
    sendJson(response, {topics: TOPICS});
    return true;
  }

  if (request.method === "POST" && (route === "/api/generate" || route === "/generate")) {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await runGenerator(normalizeGeneratePayload(payload)));
    } catch (error) {
      if (error.payload) {
        sendJson(response, error.payload, 500);
      } else {
        sendError(response, errorStatus(error), error.message);
      }
    }
    return true;
  }

  return false;
}
