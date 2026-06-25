import {canonicalTopic} from "./paths.js";

export const REQUIRED_HASHTAGS = ["#UTBK", "#UTBK2027", "#LatsoalUTBK", "#BelajarUTBK", "#SoalUTBK"];

export function normalizeQuestionForStorage(question = {}) {
  const normalized = {...question};
  if (normalized.topik) {
    normalized.topik = canonicalTopic(normalized.mapel, normalized.topik);
  }
  return normalized;
}

export function normalizeCaptionForStorage(question = {}, caption = {}) {
  const normalized = {...caption};
  normalized.caption = `${question.mapel || ""}\n${question.topik || ""}`.trim();

  const rawHashtags = Array.isArray(normalized.hashtag) ? normalized.hashtag : [];
  const merged = [];
  for (let tag of [...REQUIRED_HASHTAGS, ...rawHashtags]) {
    tag = String(tag || "").trim();
    if (!tag) continue;
    if (!tag.startsWith("#")) tag = `#${tag}`;
    if (!merged.includes(tag)) merged.push(tag);
  }
  normalized.hashtag = merged;
  return normalized;
}
