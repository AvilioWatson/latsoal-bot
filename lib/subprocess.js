import {spawn} from "node:child_process";

const DEFAULT_TIMEOUT_MS = Number(process.env.SUBPROCESS_TIMEOUT_MS || 60000);
const DEFAULT_MAX_OUTPUT_BYTES = Number(process.env.SUBPROCESS_MAX_OUTPUT_BYTES || 1024 * 1024);

function processError(message, code, details = {}) {
  return Object.assign(new Error(message), {code, ...details});
}

function appendOutput(current, chunk, limit) {
  const next = current + chunk;
  return next.length > limit ? next.slice(0, limit) : next;
}

/**
 * Run a local child process with bounded output and a deterministic timeout.
 * Callers remain responsible for interpreting the child exit code and stdout.
 */
export function runSubprocess(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = Number(options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let stdout = "";
    let stderr = "";

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const terminate = () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk, maxOutputBytes);
      if (stdout.length >= maxOutputBytes) {
        outputExceeded = true;
        terminate();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk, maxOutputBytes);
      if (stderr.length >= maxOutputBytes) {
        outputExceeded = true;
        terminate();
      }
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (exitCode, signal) => {
      if (timedOut) {
        finish(reject, processError(`Process did not respond within ${Math.max(1, Math.ceil(timeoutMs / 1000))}s.`, "subprocess_timeout", {stdout, stderr}));
        return;
      }
      if (outputExceeded) {
        finish(reject, processError(`Process output exceeded ${maxOutputBytes} bytes.`, "subprocess_output_limit", {stdout, stderr}));
        return;
      }
      finish(resolve, {exitCode, signal, stdout, stderr});
    });

    if (options.input !== undefined) child.stdin.end(options.input);
  });
}
