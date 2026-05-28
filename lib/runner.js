import {spawn} from "node:child_process";
import {ROOT, buildWebFiles} from "./paths.js";
import {validateGeneratorOutput} from "./validator.js";

const PYTHON = process.env.PYTHON || "python";
const GENERATOR_TIMEOUT_MS = Number(process.env.GENERATOR_TIMEOUT_MS || 60000);
const GENERATOR_TIMEOUT_LABEL = `${Math.max(1, Math.ceil(GENERATOR_TIMEOUT_MS / 1000))}s`;

export function runGenerator(payload) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const args = [
      "content_generator.py",
      "--mapel",
      payload.mapel || "Penalaran Umum",
      "--topik",
      payload.topik || "Penalaran deduktif",
      "--level",
      payload.level || "sedang",
      "--mode",
      payload.mode || "auto",
      "--account",
      payload.account || "@namaakun",
    ];

    const child = spawn(PYTHON, args, {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.removeAllListeners("error");
      child.removeAllListeners("close");
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const finishResolve = (metadata) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(metadata);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      const elapsed = Date.now() - startedAt;
      console.error(`[TIMEOUT] run_id=unknown elapsed=${elapsed}ms`);
      child.kill("SIGKILL");
    }, GENERATOR_TIMEOUT_MS);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", finishReject);
    child.on("close", (code) => {
      if (timedOut) {
        finishReject(Object.assign(
          new Error(`generator did not respond within ${GENERATOR_TIMEOUT_LABEL}`),
          {
            payload: {
              ok: false,
              error: "timeout",
              detail: `generator did not respond within ${GENERATOR_TIMEOUT_LABEL}`,
            },
          },
        ));
        return;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch (error) {
        finishReject(new Error(`Output generator bukan JSON valid: ${error.message}`));
        return;
      }

      if (parsed && parsed.ok === false) {
        const error = new Error(parsed.detail || parsed.error || "Generator gagal.");
        error.payload = parsed;
        finishReject(error);
        return;
      }

      if (code !== 0) {
        const error = new Error(parsed.detail || stderr || `Generator keluar dengan kode ${code}.`);
        error.payload = parsed;
        finishReject(error);
        return;
      }

      try {
        validateGeneratorOutput(parsed);
        parsed.web_files = buildWebFiles("/outputs", parsed.run_id);
        finishResolve(parsed);
      } catch (error) {
        finishReject(error);
      }
    });
  });
}
