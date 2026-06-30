import {errorStatus, readJsonBody, sendError, sendJson} from "../lib/http.js";
import {TOPICS, addTopicToSubtest, configPayload, deleteTopicFromSubtest} from "../lib/taxonomy.js";
import {generateAutoBatchFromPayload, generateFromPayload} from "../services/generate-service.js";

export {TOPICS};

export async function handle(request, response, route) {
  if (request.method === "GET" && (route === "/api/config" || route === "/config")) {
    sendJson(response, configPayload());
    return true;
  }

  if (request.method === "POST" && (route === "/api/config/topics" || route === "/config/topics")) {
    try {
      const payload = await readJsonBody(request, {limitBytes: 32 * 1024});
      sendJson(response, {
        ok: true,
        ...(await addTopicToSubtest(payload)),
        config: configPayload(),
      });
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
    return true;
  }

  if (request.method === "DELETE" && (route === "/api/config/topics" || route === "/config/topics")) {
    try {
      const payload = await readJsonBody(request, {limitBytes: 32 * 1024});
      sendJson(response, {
        ok: true,
        ...(await deleteTopicFromSubtest(payload)),
        config: configPayload(),
      });
    } catch (error) {
      sendError(response, errorStatus(error), error.message);
    }
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
