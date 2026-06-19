function sourceText(data) {
  if (data.source === "gemini" && (!data.fallbacks || data.fallbacks.length === 0)) {
    return "Gemini penuh";
  }
  if (data.source === "kimi" && (!data.fallbacks || data.fallbacks.length === 0)) {
    return "Kimi penuh";
  }
  if (data.source === "fallback") {
    return "Fallback lokal";
  }
  if (data.fallbacks && data.fallbacks.length > 0) {
    const provider = data.provider === "kimi" || data.source === "kimi" ? "Kimi" : "Gemini";
    return `${provider} + fallback ${data.fallbacks.join(", ")}`;
  }
  return data.source || "Draft lokal";
}

function renderDebug(data, elements) {
  const {debugPanel, debugSource, debugText} = elements;
  const errors = data.errors || {};
  const fallbacks = data.fallbacks || [];
  const hasDuplicate = data.dedup && data.dedup.is_duplicate;
  const hasDebug = Object.keys(errors).length > 0 || fallbacks.length > 0 || data.source === "fallback" || hasDuplicate;
  debugPanel.hidden = !hasDebug;
  if (!hasDebug) {
    debugText.textContent = "";
    debugSource.textContent = "Tidak ada";
    return;
  }

  debugSource.textContent = data.source || "unknown";
  debugText.textContent = JSON.stringify({
    source: data.source,
    review_status: data.review_status,
    fallbacks,
    errors,
    dedup: data.dedup,
    ai_usage: data.ai_usage,
    provider: data.provider,
    model: data.model,
  }, null, 2);
}

function renderImages(data, elements, options = {}) {
  const {imageCount, imagePreviewList} = elements;
  const images = data.web_files?.images || [];
  imageCount.textContent = `${images.length} page`;
  imagePreviewList.innerHTML = "";
  if (images.length === 0) {
    const empty = document.createElement("p");
    empty.className = "body-copy";
    empty.textContent = "Gambar 1000x1000 akan muncul di sini.";
    imagePreviewList.append(empty);
    return;
  }
  images.forEach((src, index) => {
    const link = document.createElement("a");
    link.href = src;
    link.target = "_blank";
    link.rel = "noopener";
    const image = document.createElement("img");
    image.className = "post-preview";
    image.src = `${src}?t=${Date.now()}`;
    image.alt = `${options.altPrefix || "Preview gambar"} ${index + 1}`;
    link.append(image);
    imagePreviewList.append(link);
  });
}

function formatQuestionText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\s+([1-9]\d?\.)\s+/g, "\n\n$1 ")
    .replace(/\s+(Simpulan\b)/g, "\n\n$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function copyCaption(elements, setStatus) {
  const {captionText, hashtagText, debugPanel, debugSource, debugText} = elements;
  const text = `${captionText.textContent}\n\n${hashtagText.textContent}`.trim();
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copied");
  } catch {
    setStatus("Error");
    debugPanel.hidden = false;
    debugSource.textContent = "clipboard";
    debugText.textContent = "Browser tidak mengizinkan clipboard. Salin caption secara manual.";
  }
}

window.LatsoalShared = {
  copyCaption,
  formatQuestionText,
  renderDebug,
  renderImages,
  sourceText,
};
