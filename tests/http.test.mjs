import assert from "node:assert/strict";
import {Readable} from "node:stream";
import test from "node:test";
import {errorStatus, readJsonBody} from "../lib/http.js";

function requestFrom(value) {
  return Readable.from([Buffer.from(value, "utf-8")]);
}

test("readJsonBody parses valid JSON bodies", async () => {
  assert.deepEqual(await readJsonBody(requestFrom('{"run_id":"20260529-123456"}')), {
    run_id: "20260529-123456",
  });
});

test("readJsonBody returns an empty object for empty bodies", async () => {
  assert.deepEqual(await readJsonBody(Readable.from([])), {});
});

test("readJsonBody marks invalid JSON as a 400 error", async () => {
  await assert.rejects(
    readJsonBody(requestFrom("{not-json")),
    (error) => error.status === 400 && /JSON valid/.test(error.message),
  );
});

test("readJsonBody marks oversized JSON as a 413 error", async () => {
  await assert.rejects(
    readJsonBody(requestFrom("x".repeat((1024 * 1024) + 1))),
    (error) => error.status === 413 && /terlalu besar/.test(error.message),
  );
});

test("errorStatus returns explicit status or fallback", () => {
  assert.equal(errorStatus({status: 400}), 400);
  assert.equal(errorStatus(new Error("boom"), 502), 502);
});
