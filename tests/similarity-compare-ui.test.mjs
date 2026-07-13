import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Bank Review exposes the two-question similarity comparison workspace", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(path.join(ROOT, "frontend", "saved.html"), "utf-8"),
    readFile(path.join(ROOT, "frontend", "saved.js"), "utf-8"),
    readFile(path.join(ROOT, "frontend", "styles.css"), "utf-8"),
  ]);

  assert.match(html, /id="similarityCompareDialog"/);
  assert.match(html, /id="similarityCompareCurrent"/);
  assert.match(html, /id="similarityCompareMatch"/);
  assert.match(html, /id="mergeSimilarityQuestionsButton"/);
  assert.match(script, /Cek kedua soal/);
  assert.match(script, /function openSimilarityComparison/);
  assert.match(script, /function generateComparisonImages/);
  assert.match(script, /merge-passage/);
  assert.match(styles, /\.similarity-compare-grid/);
  assert.match(styles, /overflow-y: auto/);
});
