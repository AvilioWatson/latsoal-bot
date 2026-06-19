export function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function wantsJson(request) {
  const accept = request.headers.accept || "";
  return accept.includes("application/json") || !accept.includes("text/html");
}

export function artifactName(file) {
  return String(file).split(/[\\/]/).pop();
}
