import {readFile} from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {readIndex} from "./lib/filestore.js";
import {sendError, sendFile, sendJson} from "./lib/http.js";
import {APPROVED, FRONTEND, OUTPUTS, ROOT, SAVED, safeJoin} from "./lib/paths.js";
import {handle as handleBank} from "./routes/bank.js";
import {handle as handleDownload} from "./routes/download.js";
import {handle as handleExport} from "./routes/export.js";
import {handle as handleGenerate, TOPICS} from "./routes/generate.js";
import {handle as handleImport} from "./routes/import.js";
import {sendStatsJson, sendStatsPage} from "./routes/stats.js";

const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || "127.0.0.1";

function slugifySubtest(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const SAVED_PAGE_ROUTES = new Set(Object.keys(TOPICS).map((name) => `/saved/${slugifySubtest(name)}`));

async function handleStaticPage(request, response, route) {
  if (request.method === "GET" && route === "/") {
    await sendFile(response, path.join(FRONTEND, "home.html"));
    return true;
  }

  if (request.method === "GET" && (route === "/generator" || route === "/generator.html")) {
    await sendFile(response, path.join(FRONTEND, "index.html"));
    return true;
  }

  if (
    request.method === "GET"
    && (route === "/saved.html" || route === "/saved" || SAVED_PAGE_ROUTES.has(route))
  ) {
    await sendFile(response, path.join(FRONTEND, "saved.html"));
    return true;
  }

  if (request.method === "GET" && (route === "/dashboard" || route === "/dashboard.html" || route === "/admin")) {
    await sendFile(response, path.join(FRONTEND, "dashboard.html"));
    return true;
  }

  if (request.method === "GET" && (route === "/import" || route === "/import.html")) {
    await sendFile(response, path.join(FRONTEND, "import.html"));
    return true;
  }

  if (request.method === "GET" && /^\/edit\/\d{8}-\d{6}$/.test(route)) {
    await sendFile(response, path.join(FRONTEND, "edit.html"));
    return true;
  }

  return false;
}

async function handleStaticAsset(request, response, route) {
  if (request.method !== "GET") return false;

  const mounts = [
    ["/assets/", FRONTEND],
    ["/outputs/", OUTPUTS],
    ["/saved/", SAVED],
    ["/approved/", APPROVED],
  ];

  for (const [prefix, base] of mounts) {
    if (!route.startsWith(prefix)) continue;
    const target = safeJoin(base, route.replace(prefix, ""));
    if (!target) {
      sendError(response, 403, "Path tidak valid.");
      return true;
    }
    await sendFile(response, target);
    return true;
  }

  return false;
}

async function handleStats(request, response, route) {
  if (request.method !== "GET" || route !== "/stats") return false;

  const accept = request.headers.accept || "";
  if (accept.includes("text/html") && !accept.includes("application/json")) {
    sendStatsPage(response);
  } else {
    await sendStatsJson(response);
  }
  return true;
}

async function handleHealth(request, response, route) {
  if (request.method !== "GET" || route !== "/health") return false;

  const packageJson = await readFile(path.join(ROOT, "package.json"), "utf-8");
  sendJson(response, {ok: true, app: JSON.parse(packageJson).name});
  return true;
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const route = decodeURIComponent(url.pathname);

  const handled = await handleGenerate(request, response, route)
    || await handleBank(request, response, route)
    || await handleImport(request, response, route)
    || await handleDownload(request, response, route)
    || await handleExport(request, response, route)
    || await handleStats(request, response, route)
    || await handleStaticPage(request, response, route)
    || await handleStaticAsset(request, response, route)
    || await handleHealth(request, response, route);

  if (!handled) {
    sendError(response, 404, "Route tidak ditemukan.");
  }
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    sendError(response, 500, error.message);
  });
});

server.listen(PORT, HOST, () => {
  readIndex().catch((error) => {
    console.error(`[INDEX] rebuild failed: ${error.message}`);
  });
  console.log(`UTBK Content Desk: http://${HOST}:${PORT}`);
});
