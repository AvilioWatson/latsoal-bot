import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {buildWebFiles, isValidRunId, safeJoin} from "../lib/paths.js";

test("safeJoin allows paths inside the base directory", () => {
  const base = path.resolve("tmp-base");
  assert.equal(safeJoin(base, "nested/file.json"), path.join(base, "nested", "file.json"));
});

test("safeJoin rejects parent traversal outside the base directory", () => {
  const base = path.resolve("tmp-base");
  assert.equal(safeJoin(base, "../outside.json"), null);
});

test("safeJoin rejects absolute paths outside the base directory", () => {
  const base = path.resolve("tmp-base");
  const outside = path.parse(base).root === base ? path.join(base, "outside") : path.parse(base).root;
  assert.equal(safeJoin(base, outside), null);
});

test("isValidRunId accepts only timestamp run ids", () => {
  assert.equal(isValidRunId("20260529-123456"), true);
  assert.equal(isValidRunId("2026-05-29-123456"), false);
  assert.equal(isValidRunId("../20260529-123456"), false);
});

test("buildWebFiles returns stable metadata, question, and caption routes", () => {
  assert.deepEqual(buildWebFiles("/outputs", "20260529-123456"), {
    question: "/outputs/20260529-123456/soal.json",
    caption: "/outputs/20260529-123456/caption.txt",
    metadata: "/outputs/20260529-123456/metadata.json",
  });
});

test("buildWebFiles maps generated image files when present", () => {
  const webFiles = buildWebFiles("/outputs", "20260529-123456", {
    images: [
      "C:\\repo\\outputs\\20260529-123456\\1.jpg",
      "C:\\repo\\outputs\\20260529-123456\\2.jpg",
      "C:\\repo\\outputs\\20260529-123456\\3.jpg",
      "C:\\repo\\outputs\\20260529-123456\\4.jpg",
    ],
    thumbnail: "C:\\repo\\outputs\\20260529-123456\\1.jpg",
    explanation: "C:\\repo\\outputs\\20260529-123456\\4.jpg",
  });
  assert.deepEqual(webFiles.images, [
    "/outputs/20260529-123456/1.jpg",
    "/outputs/20260529-123456/2.jpg",
    "/outputs/20260529-123456/3.jpg",
    "/outputs/20260529-123456/4.jpg",
  ]);
  assert.equal(webFiles.thumbnail, "/outputs/20260529-123456/1.jpg");
  assert.equal(webFiles.explanation, "/outputs/20260529-123456/4.jpg");
});
