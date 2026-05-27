const form = document.querySelector("#generateForm");
const mapelSelect = document.querySelector("#mapel");
const topicSelect = document.querySelector("#topik");
const button = document.querySelector("#generateButton");
const sourceStatus = document.querySelector("#sourceStatus");
const sourceLabel = document.querySelector("#sourceLabel");
const previewTitle = document.querySelector("#previewTitle");
const questionImage = document.querySelector("#questionImage");
const solutionImage = document.querySelector("#solutionImage");
const questionText = document.querySelector("#questionText");
const choicesList = document.querySelector("#choicesList");
const captionText = document.querySelector("#captionText");
const hashtagText = document.querySelector("#hashtagText");
const validationScore = document.querySelector("#validationScore");
const metadataLink = document.querySelector("#metadataLink");

let topicsByMapel = {};

function setStatus(text) {
  sourceStatus.textContent = text;
}

function fillTopics() {
  const topics = topicsByMapel[mapelSelect.value] || [];
  topicSelect.innerHTML = "";
  for (const topic of topics) {
    const option = document.createElement("option");
    option.value = topic;
    option.textContent = topic;
    topicSelect.append(option);
  }
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();
  topicsByMapel = config.topics;
  mapelSelect.innerHTML = "";
  for (const mapel of Object.keys(topicsByMapel)) {
    const option = document.createElement("option");
    option.value = mapel;
    option.textContent = mapel;
    mapelSelect.append(option);
  }
  fillTopics();
}

function renderResult(data) {
  const question = data.question;
  const caption = data.caption;
  const validation = data.validation;
  previewTitle.textContent = `${question.mapel}: ${question.topik}`;
  sourceLabel.textContent = data.source === "gemini" ? "Gemini" : "Draft lokal";
  validationScore.textContent = `Skor ${validation.skor ?? "-"}`;
  questionText.textContent = question.soal;

  choicesList.innerHTML = "";
  for (const [key, value] of Object.entries(question.pilihan)) {
    const item = document.createElement("li");
    item.innerHTML = `<strong>${key}</strong><span></span>`;
    item.querySelector("span").textContent = value;
    choicesList.append(item);
  }

  captionText.textContent = caption.caption || "";
  hashtagText.textContent = (caption.hashtag || []).join(" ");
  questionImage.src = `${data.web_files.post_soal}?v=${Date.now()}`;
  solutionImage.src = `${data.web_files.post_pembahasan}?v=${Date.now()}`;
  metadataLink.href = data.web_files.metadata;
  metadataLink.hidden = false;
}

mapelSelect.addEventListener("change", fillTopics);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  setStatus("Generating");

  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Generate gagal.");
    }
    renderResult(data);
    setStatus(data.source === "gemini" ? "Gemini" : "Draft");
  } catch (error) {
    setStatus("Error");
    captionText.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

loadConfig().catch((error) => {
  setStatus("Error");
  captionText.textContent = error.message;
});
