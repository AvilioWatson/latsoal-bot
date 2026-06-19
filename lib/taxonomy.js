import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TAXONOMY = JSON.parse(readFileSync(path.join(ROOT, "config", "taxonomy.json"), "utf-8"));
export const TOPICS = TAXONOMY.topics || {};
export const PATTERN_FILES = TAXONOMY.pattern_files || {};

export function configPayload() {
  return {
    topics: TOPICS,
    subtest_codes: TAXONOMY.subtest_codes || {},
    topic_aliases: TAXONOMY.topic_aliases || {},
    pattern_files: PATTERN_FILES,
  };
}
