import {createReadStream} from "node:fs";
import {stat} from "node:fs/promises";
import path from "node:path";
import {MIME} from "./paths.js";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

export function sendJson(response, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  response.end(body);
}

export function sendError(response, status, message) {
  sendJson(response, {error: message}, status);
}

export function errorStatus(error, fallback = 500) {
  return Number.isInteger(error?.status) ? error.status : fallback;
}

export async function sendFile(response, filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      sendError(response, 404, "File tidak ditemukan.");
      return;
    }
    const extension = path.extname(filePath).toLowerCase();
    const dynamicAssetHeaders = [".html", ".css", ".js"].includes(extension)
      ? {"Cache-Control": "no-store"}
      : {};
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      ...dynamicAssetHeaders,
      "Content-Type": MIME[extension] || "application/octet-stream",
      "Content-Length": info.size,
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendError(response, 404, "File tidak ditemukan.");
  }
}

export async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  const limit = 1024 * 1024;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error("Request body terlalu besar.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const error = new Error("Request body harus berupa JSON valid.");
    error.status = 400;
    throw error;
  }
}
