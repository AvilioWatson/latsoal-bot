import {createReadStream} from "node:fs";
import {access} from "node:fs/promises";
import path from "node:path";
import {MIME} from "./paths.js";

export function sendJson(response, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  response.end(body);
}

export function sendError(response, status, message) {
  sendJson(response, {error: message}, status);
}

export async function sendFile(response, filePath) {
  try {
    await access(filePath);
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {"Content-Type": MIME[extension] || "application/octet-stream"});
    createReadStream(filePath).pipe(response);
  } catch {
    sendError(response, 404, "File tidak ditemukan.");
  }
}

export async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}
