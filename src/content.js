const DEFAULTS = {
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

const state = {
  cues: [],
  activeKey: "",
  currentIndex: -1,
  settings: DEFAULTS,
  translating: false,
  seenUrls: new Set(),
  ui: {
    overlay: null,
    status: null,
    activateButton: null
  },
  chromeTranslatorActivation: null
};

injectPageHook();
boot();

async function boot() {
  window.addEventListener("message", onPageMessage);
  document.addEventListener("fullscreenchange", () => {
    mountUi();
    state.currentIndex = -1;
  });
  state.settings = await chrome.storage.sync.get(DEFAULTS);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [key, value] of Object.entries(changes)) {
      state.settings[key] = value.newValue;
    }
  });

  createOverlay();
  createStatus();
  createActivateButton();
  mountUi();
  requestAnimationFrame(syncOverlay);
  showStatus("等待 Netflix 字幕轨道...");
}

function injectPageHook() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/pageHook.js");
  script.onload = () => script.remove();
  (document.documentElement || document.head).appendChild(script);
}

function onPageMessage(event) {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (event.data?.source !== "ncs-page-hook") return;
  if (event.data.type !== "TIMED_TEXT_URL") return;
  void handleSubtitleUrl(event.data.url);
}

async function handleSubtitleUrl(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url || state.seenUrls.has(url)) return;
  state.seenUrls.add(url);

  try {
    const fetched = await sendMessage({ type: "FETCH_TEXT", url });
    if (!fetched.ok) {
      showStatus(`字幕读取失败：${fetched.error || "Netflix 拒绝了字幕请求"}`);
      return;
    }
    const text = fetched.text;
    const cues = parseSubtitle(text);
    if (cues.length < 3) {
      if (shouldReportUnparsedPayload(fetched)) {
        showStatus(`字幕请求不是可解析文本：${describePayload(fetched)}`, { sticky: true });
      }
      return;
    }
    if (!looksMostlyTranslatable(cues)) return;
    showStatus(`已解析 ${cues.length} 条字幕，准备翻译`);

    const cacheKey = await cacheKeyFor(cues);
    if (cacheKey === state.activeKey) return;
    state.activeKey = cacheKey;
    state.cues = cues;
    state.currentIndex = -1;

    const cached = await readCachedSubtitle(cacheKey, cues);
    if (cached) {
      state.cues = cached;
      showStatus(`中文字幕已从缓存加载 ${cacheKey.slice(-6)}`);
      return;
    }

    if (state.settings.translationProvider === "openai" && !state.settings.apiKey) {
      showStatus("请先在扩展设置里填写 OpenAI API Key", { sticky: true });
      return;
    }
    if (state.settings.translationProvider === "google" && !state.settings.googleApiKey) {
      showStatus("请先在扩展设置里填写 Google Cloud API Key", { sticky: true });
      return;
    }

    void translateCues(cacheKey);
  } catch (error) {
    showStatus(`字幕处理失败：${error.message}`);
  }
}

function normalizeUrl(rawUrl) {
  try {
    return new URL(rawUrl, location.href).href;
  } catch (_) {
    return "";
  }
}

function parseSubtitle(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return parseJsonSubtitle(trimmed);
  if (trimmed.startsWith("WEBVTT")) return parseVtt(trimmed);
  return parseTtml(trimmed);
}

function parseJsonSubtitle(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    return [];
  }

  const events = findSubtitleEvents(json);
  if (!events.length) return [];

  const cues = [];
  for (const event of events) {
    const start = readJsonTime(event, ["tStartMs", "startMs"], ["start", "begin"]);
    const duration = readJsonTime(event, ["dDurationMs", "durationMs"], ["dur", "duration"]);
    const explicitEnd = readJsonTime(event, ["tEndMs", "endMs"], ["end"]);
    const textValue = textFromJsonEvent(event);
    const end = Number.isFinite(explicitEnd) ? explicitEnd : start + duration;
    if (Number.isFinite(start) && Number.isFinite(end) && textValue) {
      cues.push({ start, end, text: textValue, zh: "" });
    }
  }
  return mergeDuplicateCues(cues);
}

function findSubtitleEvents(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    const direct = value.filter((item) => item && typeof item === "object" && textFromJsonEvent(item));
    if (direct.length) return direct;
    return value.flatMap(findSubtitleEvents);
  }

  for (const key of ["events", "subtitles", "cues", "timedtext", "body"]) {
    if (Array.isArray(value[key])) {
      const found = findSubtitleEvents(value[key]);
      if (found.length) return found;
    }
  }

  return [];
}

function textFromJsonEvent(event) {
  if (typeof event.text === "string") return cleanCueText(event.text);
  if (typeof event.utf8 === "string") return cleanCueText(event.utf8);
  if (typeof event.content === "string") return cleanCueText(event.content);
  if (Array.isArray(event.segs)) {
    return cleanCueText(event.segs.map((seg) => seg.utf8 || seg.text || "").join(""));
  }
  if (Array.isArray(event.segments)) {
    return cleanCueText(event.segments.map((seg) => seg.utf8 || seg.text || seg.content || "").join(""));
  }
  return "";
}

function readJsonTime(object, millisecondKeys, secondKeys = []) {
  for (const key of millisecondKeys) {
    if (object[key] === null || object[key] === undefined || object[key] === "") continue;
    const number = Number(object[key]);
    if (Number.isFinite(number)) return number / 1000;
  }
  for (const key of secondKeys) {
    if (object[key] === null || object[key] === undefined || object[key] === "") continue;
    const number = Number(object[key]);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

function parseVtt(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timingLine = lines.findIndex((line) => line.includes("-->"));
    if (timingLine < 0) continue;
    const [startRaw, endRaw] = lines[timingLine].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const cueText = lines.slice(timingLine + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    const start = parseTime(startRaw);
    const end = parseTime(endRaw);
    if (Number.isFinite(start) && Number.isFinite(end) && cueText) cues.push({ start, end, text: cueText, zh: "" });
  }
  return mergeDuplicateCues(cues);
}

function parseTtml(text) {
  const cues = [];
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const root = doc.documentElement;
  const tickRate = Number(root?.getAttribute("ttp:tickRate") || root?.getAttribute("tickRate") || 10000000);
  const frameRate = Number(root?.getAttribute("ttp:frameRate") || root?.getAttribute("frameRate") || 30);
  const paragraphs = Array.from(doc.getElementsByTagName("*")).filter((node) => node.localName === "p");
  for (const p of paragraphs) {
    const start = parseTime(p.getAttribute("begin"), { tickRate, frameRate });
    const end = parseTime(p.getAttribute("end"), { tickRate, frameRate }) || start + parseTime(p.getAttribute("dur"), { tickRate, frameRate });
    const cueText = cleanCueText(p.textContent || "");
    if (Number.isFinite(start) && Number.isFinite(end) && cueText) cues.push({ start, end, text: cueText, zh: "" });
  }
  return mergeDuplicateCues(cues);
}

function parseTime(value, options = {}) {
  if (!value) return NaN;
  const raw = String(value).trim();
  const clock = raw.match(/^(\d+):(\d{2}):(\d{2})(?:[.,](\d+))?$/);
  if (clock) {
    const [, hours, minutes, seconds, fraction = "0"] = clock;
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction}`);
  }
  const unit = raw.match(/^([\d.]+)(h|m|s|ms|t|f)$/);
  if (!unit) return Number(raw);
  const amount = Number(unit[1]);
  if (unit[2] === "h") return amount * 3600;
  if (unit[2] === "m") return amount * 60;
  if (unit[2] === "ms") return amount / 1000;
  if (unit[2] === "t") return amount / (options.tickRate || 10000000);
  if (unit[2] === "f") return amount / (options.frameRate || 30);
  return amount;
}

function cleanCueText(text) {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function mergeDuplicateCues(cues) {
  const result = [];
  for (const cue of cues.sort((a, b) => a.start - b.start)) {
    const prev = result[result.length - 1];
    if (prev && Math.abs(prev.start - cue.start) < 0.02 && Math.abs(prev.end - cue.end) < 0.02 && prev.text === cue.text) continue;
    result.push(cue);
  }
  return result;
}

function looksMostlyTranslatable(cues) {
  const sample = cues.slice(0, 80).map((cue) => cue.text).join(" ");
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  return latin >= 20;
}

async function translateCues(cacheKey) {
  if (state.translating) return;
  state.translating = true;
  showStatus("正在生成中文字幕...");

  const chunks = chunkArray(state.cues, 32);
  let completed = 0;

  try {
    await mapLimit(chunks, 2, async (chunk) => {
      const translations = await translateChunk(chunk);
      for (let i = 0; i < translations.length; i += 1) {
        if (translations[i]) chunk[i].zh = translations[i];
      }
      completed += chunk.length;
      showStatus(`中文字幕生成中 ${Math.min(completed, state.cues.length)}/${state.cues.length}`);
    });

    const repaired = await repairMissingTranslations();
    const fallbackCount = fillMissingTranslationsWithOriginal();
    await writeCachedSubtitle(cacheKey, state.cues, { fallbackCount });
    const repairedText = repaired ? `，补翻 ${repaired} 条` : "";
    const fallbackText = fallbackCount ? `，${fallbackCount} 条原文兜底` : "";
    showStatus(`中文字幕已准备好${repairedText}${fallbackText}，已缓存 ${cacheKey.slice(-6)}`);
  } catch (error) {
    showStatus(`翻译失败：${error.message}`);
  } finally {
    state.translating = false;
  }
}

async function translateChunk(cues) {
  if (state.settings.translationProvider === "chromeTranslator") {
    return translateWithChromeTranslator(cues);
  }

  const response = await sendMessage({ type: "TRANSLATE_CHUNK", cues });
  if (!response.ok) throw new Error(response.error || "翻译请求失败");
  return parseTranslationArray(response.content, cues.length);
}

async function translateWithChromeTranslator(cues) {
  if (!("Translator" in self)) {
    throw new Error("当前 Chrome 不支持内置 Translator API。请升级 Chrome 138+，或切回 OpenAI/LibreTranslate。");
  }

  const targetLanguage = state.settings.targetChinese === "traditional" ? "zh-Hant" : "zh";
  const availability = await self.Translator.availability({
    sourceLanguage: "en",
    targetLanguage
  });

  if (availability === "unavailable") {
    throw new Error(`Chrome 内置翻译不支持 en -> ${targetLanguage}`);
  }

  if (!translateWithChromeTranslator.instance || translateWithChromeTranslator.targetLanguage !== targetLanguage) {
    if (availability === "downloadable" || availability === "downloading") {
      translateWithChromeTranslator.instance = await requestChromeTranslatorActivation(targetLanguage, availability);
    } else {
      showStatus("正在启动 Chrome 本地翻译...");
      translateWithChromeTranslator.instance = await createChromeTranslator(targetLanguage);
    }
    translateWithChromeTranslator.targetLanguage = targetLanguage;
  }

  const text = cues.map((cue) => cue.text).join("\n###NCS_LINE###\n");
  const translated = await translateWithChromeTranslator.instance.translate(text);
  const parts = String(translated)
    .split(/(?:\n\s*)?###\s*NCS_LINE\s*###(?:\s*\n)?/i)
    .map(cleanCueText);

  if (parts.length === cues.length && parts.every(Boolean)) return parts;

  const translations = [];
  for (const cue of cues) {
    translations.push(cleanCueText(await translateWithChromeTranslator.instance.translate(cue.text)));
  }
  return translations;
}

function requestChromeTranslatorActivation(targetLanguage, availability) {
  if (state.chromeTranslatorActivation?.targetLanguage === targetLanguage) {
    return state.chromeTranslatorActivation.promise;
  }

  const button = state.ui.activateButton;
  if (!button) throw new Error("Chrome 翻译需要点击启用，请刷新页面后重试。");

  showStatus(
    availability === "downloadable"
      ? "Chrome 本地翻译需要你点击一次来下载语言包"
      : "Chrome 本地翻译需要你点击一次来继续下载",
    { sticky: true }
  );

  button.textContent = "启用 Chrome 本地翻译";
  button.hidden = false;
  mountUi();

  const promise = new Promise((resolve, reject) => {
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = "正在启用...";
      try {
        const translator = await createChromeTranslator(targetLanguage);
        button.hidden = true;
        button.disabled = false;
        button.onclick = null;
        resolve(translator);
      } catch (error) {
        button.disabled = false;
        button.textContent = "重试启用 Chrome 本地翻译";
        reject(error);
      } finally {
        state.chromeTranslatorActivation = null;
      }
    };
  });

  state.chromeTranslatorActivation = { targetLanguage, promise };
  return promise;
}

async function createChromeTranslator(targetLanguage) {
  return self.Translator.create({
    sourceLanguage: "en",
    targetLanguage,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        showStatus(`Chrome 翻译语言包下载中 ${Math.round(event.loaded * 100)}%`, { sticky: true });
      });
    }
  });
}

function parseTranslationArray(content, expectedLength) {
  let raw = content.trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) raw = fenced[1].trim();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("翻译服务返回格式不是数组");
  const translations = Array(expectedLength).fill("");

  for (let i = 0; i < Math.min(parsed.length, expectedLength); i += 1) {
    const item = parsed[i];
    if (typeof item === "string") translations[i] = cleanCueText(item);
    else if (item && typeof item === "object") {
      const index = Number.isInteger(item.i) && item.i >= 0 && item.i < expectedLength ? item.i : i;
      translations[index] = cleanCueText(String(item.zh || item.translation || item.text || item.content || ""));
    }
  }

  return translations;
}

async function repairMissingTranslations() {
  const missing = state.cues
    .map((cue, index) => ({ cue, index }))
    .filter(({ cue }) => !cue.zh);
  if (!missing.length) return 0;

  showStatus(`正在补翻漏掉的 ${missing.length} 条字幕...`);
  let repaired = 0;
  const chunks = chunkArray(missing, 12);

  await mapLimit(chunks, 1, async (chunk) => {
    const translations = await translateChunk(chunk.map(({ cue }) => cue));
    for (let i = 0; i < chunk.length; i += 1) {
      if (translations[i]) {
        state.cues[chunk[i].index].zh = translations[i];
        repaired += 1;
      }
    }
  });

  return repaired;
}

function fillMissingTranslationsWithOriginal() {
  let fallbackCount = 0;
  for (const cue of state.cues) {
    if (!cue.zh) {
      cue.zh = cue.text;
      fallbackCount += 1;
    }
  }
  return fallbackCount;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function mapLimit(items, limit, worker) {
  const executing = new Set();
  for (const item of items) {
    const promise = Promise.resolve().then(() => worker(item));
    executing.add(promise);
    promise.finally(() => executing.delete(promise));
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}

async function readCachedSubtitle(cacheKey, cues) {
  const stored = await chrome.storage.local.get(cacheKey);
  const raw = stored[cacheKey];
  if (!raw) {
    showStatus(`缓存未命中 ${cacheKey.slice(-6)}`);
    return null;
  }

  let entry;
  try {
    entry = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) {
    showStatus(`缓存损坏 ${cacheKey.slice(-6)}`);
    return null;
  }

  if (!isCompleteCachedSubtitle(entry, cues)) {
    showStatus(`缓存不完整，重新生成 ${cacheKey.slice(-6)}`);
    return null;
  }

  return cues.map((cue, index) => ({ ...cue, zh: entry.zh[index] }));
}

async function writeCachedSubtitle(cacheKey, cues, meta = {}) {
  const entry = {
    version: 2,
    savedAt: Date.now(),
    targetChinese: state.settings.targetChinese,
    fallbackCount: meta.fallbackCount || 0,
    text: cues.map((cue) => cue.text),
    zh: cues.map((cue) => cue.zh || "")
  };

  if (!isCompleteCachedSubtitle(entry, cues)) {
    throw new Error("字幕翻译未完整，暂不写入缓存");
  }

  await chrome.storage.local.set({ [cacheKey]: JSON.stringify(entry) });
  const verify = await chrome.storage.local.get(cacheKey);
  if (!verify[cacheKey]) throw new Error("缓存写入后未读回");
}

function isCompleteCachedSubtitle(entry, cues) {
  return (
    entry?.version === 2 &&
    entry?.text?.length === cues.length &&
    entry?.zh?.length === cues.length &&
    entry.zh.every(Boolean) &&
    entry.text.every((text, index) => text === cues[index]?.text)
  );
}

async function cacheKeyFor(cues) {
  const provider = state.settings.translationProvider || "openai";
  const digest = await sha256(`${videoIdFromPath()}|${provider}|${state.settings.targetChinese}|${subtitleTextFingerprint(cues)}`);
  return `ncs:${digest}`;
}

function videoIdFromPath() {
  return location.pathname.match(/\/watch\/(\d+)/)?.[1] || location.pathname;
}

function subtitleTextFingerprint(cues) {
  return cues.map((cue) => cue.text).join("\n");
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createOverlay() {
  if (state.ui.overlay) return;
  const overlay = document.createElement("div");
  overlay.className = "ncs-overlay";
  overlay.hidden = true;
  overlay.innerHTML = '<span class="ncs-line"></span><span class="ncs-original"></span>';
  state.ui.overlay = overlay;
}

function createStatus() {
  if (state.ui.status) return;
  const status = document.createElement("div");
  status.className = "ncs-status";
  status.hidden = true;
  state.ui.status = status;
}

function createActivateButton() {
  if (state.ui.activateButton) return;
  const button = document.createElement("button");
  button.className = "ncs-activate";
  button.type = "button";
  button.hidden = true;
  state.ui.activateButton = button;
}

function syncOverlay() {
  mountUi();
  const video = document.querySelector("video");
  const overlay = state.ui.overlay;
  const line = overlay?.querySelector(".ncs-line");
  const original = overlay?.querySelector(".ncs-original");

  if (video && overlay && line && original) {
    const time = video.currentTime;
    const index = findCueIndex(state.cues, time);
    if (index !== state.currentIndex) {
      state.currentIndex = index;
      const cue = state.cues[index];
      if (cue?.zh) {
        line.textContent = cue.zh;
        original.textContent = state.settings.showOriginal && cue.zh ? cue.text : "";
        overlay.hidden = false;
      } else {
        line.textContent = "";
        original.textContent = "";
        overlay.hidden = true;
      }
    }
  }

  requestAnimationFrame(syncOverlay);
}

function mountUi() {
  const overlay = state.ui.overlay;
  const status = state.ui.status;
  const activateButton = state.ui.activateButton;
  if (!overlay || !status || !activateButton) return;

  const host = getOverlayHost();
  if (overlay.parentElement !== host) host.appendChild(overlay);
  if (status.parentElement !== host) host.appendChild(status);
  if (activateButton.parentElement !== host) host.appendChild(activateButton);

  if (host !== document.documentElement && host !== document.body) {
    const position = getComputedStyle(host).position;
    if (position === "static") host.style.position = "relative";
  }

  overlay.classList.toggle("ncs-in-fullscreen", Boolean(document.fullscreenElement));
  status.classList.toggle("ncs-in-fullscreen", Boolean(document.fullscreenElement));
  activateButton.classList.toggle("ncs-in-fullscreen", Boolean(document.fullscreenElement));
}

function getOverlayHost() {
  if (document.fullscreenElement) return document.fullscreenElement;
  return (
    document.querySelector(".watch-video") ||
    document.querySelector(".NFPlayer") ||
    document.querySelector("[data-uia='player']") ||
    document.body ||
    document.documentElement
  );
}

function findCueIndex(cues, time) {
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const cue = cues[mid];
    if (time < cue.start) high = mid - 1;
    else if (time > cue.end) low = mid + 1;
    else return mid;
  }
  return -1;
}

function showStatus(text, options = {}) {
  mountUi();
  const status = state.ui.status;
  if (!status) return;
  status.textContent = text;
  status.hidden = false;
  clearTimeout(showStatus.timer);
  if (!options.sticky) {
    showStatus.timer = setTimeout(() => {
      status.hidden = true;
    }, 4200);
  }
}

function describePayload(fetched) {
  const contentType = fetched.contentType || "unknown";
  const sample = (fetched.text || "")
    .trim()
    .slice(0, 90)
    .replace(/\s+/g, " ");
  if (!sample) return `${contentType}; 空响应`;
  return `${contentType}; ${sample}`;
}

function shouldReportUnparsedPayload(fetched) {
  const contentType = (fetched.contentType || "").toLowerCase();
  const sample = (fetched.text || "").trim().slice(0, 64);
  if (!sample) return false;
  if (contentType.includes("application/octet-stream")) return false;
  if (looksLikeMediaFragment(sample)) return false;
  return looksLikeSubtitlePayload(sample, contentType);
}

function looksLikeMediaFragment(sample) {
  return (
    sample.includes("ftyp") ||
    sample.includes("moof") ||
    sample.includes("mdat") ||
    sample.includes("mfra") ||
    sample.includes("sidx")
  );
}

function looksLikeSubtitlePayload(sample, contentType) {
  if (contentType.includes("json") || contentType.includes("xml") || contentType.includes("text")) return true;
  return (
    sample.startsWith("{") ||
    sample.startsWith("[") ||
    sample.startsWith("<") ||
    sample.startsWith("WEBVTT")
  );
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response || { ok: false, error: "No response" });
    });
  });
}
