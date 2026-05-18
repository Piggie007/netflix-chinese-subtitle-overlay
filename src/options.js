const defaults = {
  translationProvider: "openai",
  apiKey: "",
  endpoint: "https://api.openai.com/v1/chat/completions",
  googleApiKey: "",
  googleEndpoint: "https://translation.googleapis.com/language/translate/v2",
  libreEndpoint: "http://localhost:5000/translate",
  model: "gpt-4.1-mini",
  targetChinese: "simplified",
  showOriginal: true
};

const ids = [
  "translationProvider",
  "apiKey",
  "endpoint",
  "googleApiKey",
  "googleEndpoint",
  "libreEndpoint",
  "model",
  "targetChinese",
  "showOriginal"
];

async function load() {
  const settings = await chrome.storage.sync.get(defaults);
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el.type === "checkbox") el.checked = Boolean(settings[id]);
    else el.value = settings[id] || "";
  }
  updateProviderFields();
}

async function save() {
  const settings = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    settings[id] = el.type === "checkbox" ? el.checked : el.value.trim();
  }
  await chrome.storage.sync.set(settings);
  showStatus("已保存。刷新 Netflix 播放页后生效。");
}

async function clearCache() {
  await chrome.storage.local.clear();
  showStatus("字幕缓存已清空。");
}

function showStatus(text) {
  const status = document.getElementById("status");
  status.textContent = text;
  window.setTimeout(() => {
    status.textContent = "";
  }, 3200);
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("clearCache").addEventListener("click", clearCache);
document.getElementById("translationProvider").addEventListener("change", updateProviderFields);
load();

function updateProviderFields() {
  const provider = document.getElementById("translationProvider").value;
  document.getElementById("openaiSettings").hidden = provider !== "openai";
  document.getElementById("googleSettings").hidden = provider !== "google";
  document.getElementById("libreSettings").hidden = provider !== "libretranslate";
  document.getElementById("chromeTranslatorHint").hidden = provider !== "chromeTranslator";
}
