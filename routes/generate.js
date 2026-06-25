import {errorStatus, readJsonBody, sendError, sendJson} from "../lib/http.js";
import {TOPICS, configPayload} from "../lib/taxonomy.js";
import {generateAutoBatchFromPayload, generateFromPayload} from "../services/generate-service.js";

export {TOPICS};

export async function handle(request, response, route) {
  if (request.method === "GET" && (route === "/api/config" || route === "/config")) {
    sendJson(response, configPayload());
    return true;
  }

  if (request.method === "POST" && (route === "/api/generate" || route === "/generate")) {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await generateFromPayload(payload));
    } catch (error) {
      if (error.payload) {
        sendJson(response, error.payload, 500);
      } else {
        sendError(response, errorStatus(error), error.message);
      }
    }
    return true;
  }

  if (request.method === "POST" && (route === "/api/generate/auto" || route === "/generate/auto")) {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, await generateAutoBatchFromPayload(payload));
    } catch (error) {
      if (error.payload) {
        sendJson(response, error.payload, 500);
      } else {
        sendError(response, errorStatus(error), error.message);
      }
    }
    return true;
  }

  return false;
}
