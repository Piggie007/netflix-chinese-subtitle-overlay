chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get({
    translationProvider: "openai",
    endpoint: "https://api.openai.com/v1/chat/completions",
    libreEndpoint: "http://localhost:5000/translate",
    model: "gpt-4.1-mini",
    targetChinese: "simplified",
    showOriginal: true,
    apiKey: ""
  });

  await chrome.storage.sync.set(existing);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "FETCH_TEXT") {
    fetchText(message.url).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TRANSLATE_CHUNK") {
    translateChunk(message.cues).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function fetchText(url) {
  const response = await fetch(url, { credentials: "include" });
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) return { ok: false, error: `${response.status} ${text.slice(0, 120)}`, contentType };
  return { ok: true, text, contentType, finalUrl: response.url };
}

async function translateChunk(cues) {
  const settings = await chrome.storage.sync.get({
    translationProvider: "openai",
    apiKey: "",
    endpoint: "https://api.openai.com/v1/chat/completions",
    libreEndpoint: "http://localhost:5000/translate",
    model: "gpt-4.1-mini",
    targetChinese: "simplified"
  });

  if (settings.translationProvider === "libretranslate") {
    return translateWithLibreTranslate(cues, settings);
  }

  return translateWithOpenAi(cues, settings);
}

async function translateWithOpenAi(cues, settings) {
  if (!settings.apiKey) return { ok: false, error: "Missing OpenAI API Key" };

  const target = settings.targetChinese === "traditional" ? "Traditional Chinese" : "Simplified Chinese";
  const payload = cues.map((cue, i) => ({ i, text: cue.text }));
  const body = {
    model: settings.model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          `Translate subtitle lines into natural ${target}. Keep names and anime terms consistent. ` +
          "Preserve meaning, tone, and line order. Translate every non-empty line. " +
          "Return only a JSON array of strings in the same order, with the same length as the input."
      },
      {
        role: "user",
        content: JSON.stringify(payload)
      }
    ]
  };

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) return { ok: false, error: `${response.status} ${text.slice(0, 120)}` };

  const json = JSON.parse(text);
  return { ok: true, content: json.choices?.[0]?.message?.content || "" };
}

async function translateWithLibreTranslate(cues, settings) {
  const endpoint = settings.libreEndpoint || "http://localhost:5000/translate";
  const target = "zh";
  const batched = await translateLibreBatch(cues, endpoint, target);
  if (batched) return { ok: true, content: JSON.stringify(batched) };

  const translations = await translateLibreLineByLine(cues, endpoint, target);
  return { ok: true, content: JSON.stringify(translations) };
}

async function translateLibreBatch(cues, endpoint, target) {
  const separator = "\n###NCS_LINE###\n";
  const q = cues.map((cue) => cue.text).join(separator);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      q,
      source: "en",
      target,
      format: "text"
    })
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 120)}`);

  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`LibreTranslate returned non-JSON: ${text.slice(0, 120)}`);
  }

  const translated = String(json.translatedText || json.translation || "");
  const parts = translated
    .split(/(?:\n\s*)?###\s*NCS_LINE\s*###(?:\s*\n)?/i)
    .map(cleanTranslation);

  if (parts.length !== cues.length || parts.some((part) => !part)) return null;
  return parts;
}

async function translateLibreLineByLine(cues, endpoint, target) {
  const translations = Array(cues.length).fill("");
  await mapLimit(cues.map((cue, index) => ({ cue, index })), 4, async ({ cue, index }) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        q: cue.text,
        source: "en",
        target,
        format: "text"
      })
    });

    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 120)}`);

    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error(`LibreTranslate returned non-JSON: ${text.slice(0, 120)}`);
    }

    translations[index] = cleanTranslation(json.translatedText || json.translation || "");
  });
  return translations;
}

function cleanTranslation(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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
