import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const pageTemplates = [
  "frontend/home.html",
  "frontend/index.html",
  "frontend/saved.html",
  "frontend/import.html",
  "frontend/dashboard.html",
  "frontend/edit.html",
];

test("all page templates load the shared ambient assets", async () => {
  for (const file of pageTemplates) {
    const html = await readFile(file, "utf-8");
    assert.match(html, /\/assets\/ambient\.css/, `${file} must load ambient.css`);
    assert.match(html, /\/assets\/ambient\.js/, `${file} must load ambient.js`);
  }

  const statsRoute = await readFile("routes/stats.js", "utf-8");
  assert.match(statsRoute, /\/assets\/ambient\.css/);
  assert.match(statsRoute, /\/assets\/ambient\.js/);
});

test("ambient scene keeps the planet hierarchy and accessibility safeguards", async () => {
  const script = await readFile("frontend/ambient.js", "utf-8");
  const styles = await readFile("frontend/ambient.css", "utf-8");

  assert.match(script, /planetSize: "7px"/);
  assert.match(script, /planetSize: "13px"/);
  assert.match(script, /planetSize: "22px"/);
  assert.equal((script.match(/moon: true/g) || []).length, 1);
  assert.match(script, /one: "\\u2211"/);
  assert.match(script, /two: "\\u03c0"/);
  assert.match(script, /four: "\\u221a"/);
  assert.match(script, /opacity: randomBetween\(0\.42, 0\.68\)/);
  assert.match(styles, /--ambient-symbol: .*\/ 0\.5\)/);
  assert.match(script, /prefers-reduced-motion: reduce/);
  assert.match(script, /pointermove/);
  assert.match(styles, /pointer-events: none/);
  assert.match(styles, /ambient-motion-paused/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});
