const $ = (id) => document.getElementById(id);

const LANGUAGES = [
  ["en-US", "English"], ["hi-IN", "Hindi · हिन्दी"], ["es-ES", "Spanish · Español"],
  ["fr-FR", "French · Français"], ["de-DE", "German · Deutsch"], ["bn-IN", "Bengali · বাংলা"],
  ["ta-IN", "Tamil · தமிழ்"], ["te-IN", "Telugu · తెలుగు"], ["mr-IN", "Marathi · मराठी"], ["ur-PK", "Urdu · اردو"],
];

for (const [code, name] of LANGUAGES) {
  $("language").add(new Option(name, code));
  $("targetLang").add(new Option(name, code));
}

let lastResult = "";
let lastLang = "";
let lastText = "";

async function loadSettings() {
  const s = await chrome.storage.local.get({ preferredLanguage: "en-US", geminiKey: "", geminiModel: "" });
  $("language").value = s.preferredLanguage;
  $("targetLang").value = s.preferredLanguage;
  $("key").value = s.geminiKey;
  $("model").value = s.geminiModel;
  updateState(!!s.geminiKey);
}

function updateState(hasKey) {
  const el = $("state");
  el.textContent = hasKey ? "AI features ready" : "Free mode · add a key for long text";
  el.classList.toggle("ready", hasKey);
}

function showResult(text, { playable = false } = {}) {
  lastResult = text;
  $("result").hidden = false;
  $("resultText").textContent = text;
  $("resultActions").hidden = !playable;
}

// Sends a message to the active tab, injecting the content script first if the
// tab was open before Margin was installed or reloaded.
async function toTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("unsupported");
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tab.id, message);
  }
}

const UNSUPPORTED = "Margin can't read this kind of page (browser pages, the Web Store and PDFs are off limits). Try a regular website.";

async function guide() {
  try {
    await toTab({ type: "EXPLAIN_PAGE" });
    window.close();
  } catch {
    showResult(UNSUPPORTED);
  }
}

async function onSelection(action) {
  let text = "";
  try {
    text = ((await toTab({ type: "GET_SELECTION" }))?.text || "").trim();
  } catch {
    return showResult(UNSUPPORTED);
  }
  if (!text) return showResult("Highlight some text on the page first, then pick an action.");

  if (action === "listen") {
    try { await toTab({ type: "SPEAK", text }); } catch {}
    return showResult("Reading the selection aloud on the page.");
  }

  lastText = text;
  return runAsk(action, text);
}

async function runAsk(action, text) {
  const target = action === "translate" ? $("targetLang").value : "";
  lastLang = target || $("language").value;
  showResult(action === "translate" ? "Translating…" : "Working it out…");
  $("resultLang").hidden = action !== "translate";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const resp = await chrome.runtime.sendMessage({ type: "ASK", task: action, text, pageTitle: tab?.title || "", targetLang: target });
  if (resp?.ok) {
    const note = resp.note ? "\n\n" + resp.note : "";
    showResult(resp.text + note, { playable: true });
    const extra = await extrasFor(text, resp);
    if (extra) showResult(resp.text + extra + note, { playable: true });
  } else if (resp?.needsKey) {
    showResult(resp.message || "Add your Gemini API key in Settings below.");
    $("settings").open = true;
    $("key").focus();
  } else showResult(resp?.error || "Something went wrong. Try again.");
}

// One word: its meaning from Wikipedia/Wiktionary. Longer text: the difficult words, explained at the end.
async function extrasFor(text, resp) {
  try {
    if (!/\s/.test(text.trim())) {
      const r = await chrome.runtime.sendMessage({ type: "WIKI", text, pageLang: "" });
      return (r?.items || []).map((it) => `\n\n${it.source}\n${it.text}`).join("");
    }
    const words = Array.isArray(resp.words) ? resp.words : (await chrome.runtime.sendMessage({ type: "WORDS", text }))?.words || [];
    return words.length ? "\n\nTricky words\n" + words.map((w) => `${w.word}: ${w.meaning}`).join("\n") : "";
  } catch {
    return "";
  }
}

function speakResult() {
  if (!("speechSynthesis" in window) || !lastResult) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(lastResult);
  u.lang = lastLang || $("language").value;
  u.rate = 0.92;
  speechSynthesis.speak(u);
}

$("guide").addEventListener("click", guide);
$("translate").addEventListener("click", () => onSelection("translate"));
$("explain").addEventListener("click", () => onSelection("explain"));
$("listen").addEventListener("click", () => onSelection("listen"));
$("play").addEventListener("click", speakResult);
$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(lastResult); $("copy").textContent = "Copied"; }
  catch { $("copy").textContent = "Copy failed"; }
  setTimeout(() => ($("copy").textContent = "Copy"), 1500);
});

$("language").addEventListener("change", () => {
  chrome.storage.local.set({ preferredLanguage: $("language").value });
  $("targetLang").value = $("language").value;
});
$("targetLang").addEventListener("change", () => { if (lastText) runAsk("translate", lastText); });

$("save").addEventListener("click", async () => {
  const apiKey = $("key").value.trim();
  await chrome.storage.local.set({
    geminiKey: apiKey,
    geminiModel: $("model").value.trim(),
    preferredLanguage: $("language").value,
  });
  updateState(!!apiKey);
  $("saved").textContent = "Saved";
  setTimeout(() => ($("saved").textContent = ""), 1800);
});

const LOCAL_OPTS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

async function refreshLocal() {
  const state = $("localState"), btn = $("localBtn");
  btn.hidden = true;
  if (!("LanguageModel" in self)) {
    state.textContent = "Not available here. It needs a recent desktop version of Chrome.";
    return;
  }
  let a;
  try { a = await LanguageModel.availability(LOCAL_OPTS); } catch { a = "unavailable"; }
  if (a === "available") state.textContent = "Ready. Sentences are explained on your device, offline and private. Output is in English, Spanish, French or German; other languages get a translated version.";
  else if (a === "downloadable") { state.textContent = "Not downloaded yet. It's a one-time download of a few GB. Keep this popup open while it runs."; btn.hidden = false; }
  else if (a === "downloading") state.textContent = "Downloading in the background. Check back in a few minutes.";
  else state.textContent = "This computer can't run it. Chrome needs about 22 GB of free disk space and supported hardware. Free mode still translates, and an API key unlocks full explanations.";
}

$("localBtn").addEventListener("click", async () => {
  const state = $("localState"), btn = $("localBtn");
  btn.disabled = true;
  try {
    const s = await LanguageModel.create({
      ...LOCAL_OPTS,
      monitor(m) { m.addEventListener("downloadprogress", (e) => { state.textContent = `Downloading… ${Math.round(e.loaded * 100)}%`; }); },
    });
    s.destroy?.();
  } catch {
    state.textContent = "The download didn't start. Check your disk space and connection, then try again.";
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  refreshLocal();
});

loadSettings();
refreshLocal();
