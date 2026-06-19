import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {PATTERN_FILES, TAXONOMY} from "../lib/taxonomy.js";
import {TOPICS} from "../routes/generate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const taxonomyConfig = JSON.parse(readFileSync(path.join(ROOT, "config", "taxonomy.json"), "utf-8"));
const topicsConfig = taxonomyConfig.topics;
const patternConfig = taxonomyConfig.pattern_files;

test("routes use the shared topics config", () => {
  assert.deepEqual(TOPICS, topicsConfig);
  assert.deepEqual(TAXONOMY, taxonomyConfig);
  assert.deepEqual(PATTERN_FILES, patternConfig);
});

test("topics config has non-empty subtests and topics", () => {
  assert.ok(Object.keys(topicsConfig).length >= 7);
  for (const [subtest, topics] of Object.entries(topicsConfig)) {
    assert.equal(typeof subtest, "string");
    assert.notEqual(subtest.trim(), "");
    assert.ok(Array.isArray(topics));
    assert.ok(topics.length > 0);
    for (const topic of topics) {
      assert.equal(typeof topic, "string");
      assert.notEqual(topic.trim(), "");
    }
  }
});

test("taxonomy config has subtest codes and topic aliases", () => {
  assert.deepEqual(Object.keys(taxonomyConfig.subtest_codes).sort(), Object.keys(topicsConfig).sort());
  for (const [subtest, code] of Object.entries(taxonomyConfig.subtest_codes)) {
    assert.equal(typeof subtest, "string");
    assert.match(code, /^[A-Z]+$/);
  }
  for (const [subtest, aliases] of Object.entries(taxonomyConfig.topic_aliases)) {
    assert.ok(Object.hasOwn(topicsConfig, subtest));
    for (const [alias, canonical] of Object.entries(aliases)) {
      assert.notEqual(alias.trim(), "");
      assert.ok(topicsConfig[subtest].includes(canonical));
    }
  }
});

test("pattern config covers every subtest and points to valid pattern files", () => {
  assert.deepEqual(Object.keys(patternConfig).sort(), Object.keys(topicsConfig).sort());

  for (const [subtest, fileName] of Object.entries(patternConfig)) {
    assert.match(fileName, /^[a-z_]+\.json$/);
    const patternPath = path.join(ROOT, "bank_soal", "patterns", fileName);
    const patternData = JSON.parse(readFileSync(patternPath, "utf-8"));
    assert.equal(patternData.subtes, subtest);
    assert.ok(Array.isArray(patternData.patterns));
    assert.ok(patternData.patterns.length > 0);
    for (const pattern of patternData.patterns) {
      assert.equal(typeof pattern.topik, "string");
      assert.notEqual(pattern.topik.trim(), "");
      assert.equal(typeof pattern.pola_soal, "string");
      assert.notEqual(pattern.pola_soal.trim(), "");
    }
  }
});
