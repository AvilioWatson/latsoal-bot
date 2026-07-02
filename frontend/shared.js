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

function syncTopbarMetrics() {
  const root = document.documentElement;
  const topbar = document.querySelector(".topbar");
  if (!topbar) {
    root.style.setProperty("--topbar-height", "64px");
    root.style.setProperty("--topbar-offset", "76px");
    return;
  }

  const height = Math.ceil(topbar.getBoundingClientRect().height);
  const offset = height + 12;
  root.style.setProperty("--topbar-height", `${height}px`);
  root.style.setProperty("--topbar-offset", `${offset}px`);
  document.body.dataset.scrolled = window.scrollY > 6 ? "true" : "false";
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

function downloadFileName(src, index) {
  try {
    return decodeURIComponent(new URL(src, window.location.href).pathname.split("/").pop()) || `gambar-${index + 1}.jpg`;
  } catch {
    return `gambar-${index + 1}.jpg`;
  }
}

async function saveImagesToFolder(data, button) {
  if (typeof window.showDirectoryPicker !== "function") {
    throw new Error("Fitur simpan folder membutuhkan Chrome atau Edge versi terbaru.");
  }

  const images = data.web_files?.images || [];
  const selectedDirectory = await window.showDirectoryPicker({mode: "readwrite"});
  const folderName = `latsoal-${data.run_id || "gambar"}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  const targetDirectory = await selectedDirectory.getDirectoryHandle(folderName, {create: true});

  for (const [index, src] of images.entries()) {
    button.textContent = `Menyimpan ${index + 1}/${images.length}`;
    const response = await fetch(src);
    if (!response.ok) throw new Error(`Gagal mengambil gambar ${index + 1}.`);
    const fileHandle = await targetDirectory.getFileHandle(downloadFileName(src, index), {create: true});
    const writable = await fileHandle.createWritable();
    await writable.write(await response.blob());
    await writable.close();
  }

  return folderName;
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
  const folderButton = document.createElement("button");
  folderButton.className = "post-preview-folder-download";
  folderButton.type = "button";
  folderButton.textContent = "Simpan semua ke folder";
  folderButton.addEventListener("click", async () => {
    const initialLabel = folderButton.textContent;
    folderButton.disabled = true;
    try {
      const folderName = await saveImagesToFolder(data, folderButton);
      folderButton.textContent = `Tersimpan di ${folderName}`;
    } catch (error) {
      if (error?.name === "AbortError") {
        folderButton.textContent = initialLabel;
      } else {
        folderButton.textContent = "Gagal menyimpan folder";
        folderButton.title = error.message;
      }
    } finally {
      folderButton.disabled = false;
    }
  });
  imagePreviewList.append(folderButton);
  images.forEach((src, index) => {
    const item = document.createElement("figure");
    item.className = "post-preview-item";
    const previewLink = document.createElement("a");
    previewLink.className = "post-preview-link";
    previewLink.href = src;
    previewLink.target = "_blank";
    previewLink.rel = "noopener";
    const image = document.createElement("img");
    image.className = "post-preview";
    image.src = `${src}?t=${Date.now()}`;
    image.alt = `${options.altPrefix || "Preview gambar"} ${index + 1}`;
    const downloadLink = document.createElement("a");
    downloadLink.className = "post-preview-download";
    downloadLink.href = src;
    downloadLink.download = downloadFileName(src, index);
    downloadLink.textContent = `Download gambar ${index + 1}`;
    previewLink.append(image);
    item.append(previewLink, downloadLink);
    imagePreviewList.append(item);
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
  saveImagesToFolder,
  syncTopbarMetrics,
  sourceText,
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", syncTopbarMetrics, {once: true});
} else {
  syncTopbarMetrics();
}

window.addEventListener("resize", syncTopbarMetrics);
window.addEventListener("scroll", syncTopbarMetrics, {passive: true});
