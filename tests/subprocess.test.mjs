import assert from "node:assert/strict";
import test from "node:test";
import {runSubprocess} from "../lib/subprocess.js";

test("runSubprocess resolves bounded successful output", async () => {
  const result = await runSubprocess(process.execPath, ["-e", "process.stdout.write('ok')"], {
    timeoutMs: 1000,
    maxOutputBytes: 100,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
});

test("runSubprocess rejects a timeout", async () => {
  await assert.rejects(
    runSubprocess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {timeoutMs: 50}),
    (error) => error.code === "subprocess_timeout",
  );
});

test("runSubprocess rejects excessive output", async () => {
  await assert.rejects(
    runSubprocess(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000))"], {
      timeoutMs: 1000,
      maxOutputBytes: 64,
    }),
    (error) => error.code === "subprocess_output_limit",
  );
});
