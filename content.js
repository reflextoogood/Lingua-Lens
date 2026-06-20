console.log("LinguaLens loaded");

// ── State ─────────────────────────────────────────────────────────────────────

let lastSubtitle     = "";
let lastCompleteLine = "";
let subtitleHistory  = [];
let captionObserver  = null;
let isRewrapping     = false;
let tooltipTimeout   = null;
let currentRequestId = 0;

const pendingRequests = new Map(); // cacheKey → Promise<string>

// ── Subtitle reading ──────────────────────────────────────────────────────────

function getSubtitleText() {
  const segments = document.querySelectorAll(".ytp-caption-segment");
  return Array.from(segments)
    .map(s => s.textContent.trim())
    .filter(Boolean)
    .join(" ");
}

// ── Word wrapping ─────────────────────────────────────────────────────────────

function wrapWordsInSegments() {
  document.querySelectorAll(".ytp-caption-segment").forEach(segment => {
    const text = segment.textContent;
    if (!text.trim()) return;

    const html = text.split(/(\s+)/).map(token => {
      if (/^\s+$/.test(token)) return token;
      const cleanWord = token.replace(/[^\p{L}\p{N}\p{M}\p{Cf}]/gu, "");
      if (!cleanWord) return token;
      return `<span class="lingualens-word" data-word="${cleanWord}">${token}</span>`;
    }).join("");

    segment.innerHTML = html;
  });
}

// ── History tracking ──────────────────────────────────────────────────────────

function updateHistory(newText) {
  if (lastCompleteLine && !newText.startsWith(lastCompleteLine)) {
    subtitleHistory.push(lastCompleteLine);
    if (subtitleHistory.length > 4) subtitleHistory.shift();
  }
  lastCompleteLine = newText;
}

// ── Mutation handler ──────────────────────────────────────────────────────────

function handleSubtitleChange() {
  if (isRewrapping) return;

  const text = getSubtitleText();
  if (!text || text === lastSubtitle) return;

  updateHistory(text);
  lastSubtitle = text;

  isRewrapping = true;
  wrapWordsInSegments();
  isRewrapping = false;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_KEY_LIST = "lingualens:__keys__";
const CACHE_MAX      = 2000;
const CACHE_EVICT    = 200; // evict oldest 10% when full

function makeCacheKey(word, line) {
  // Truncate the line so localStorage keys stay reasonable in length.
  const trimmedLine = line.length > 80 ? line.slice(0, 80) : line;
  return `lingualens:${word}:${trimmedLine}`;
}

function cacheGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function cacheSet(key, value) {
  try {
    let keys = [];
    try { keys = JSON.parse(localStorage.getItem(CACHE_KEY_LIST) || "[]"); } catch {}

    if (keys.length >= CACHE_MAX) {
      // FIFO eviction: remove the oldest CACHE_EVICT entries from the front.
      keys.splice(0, CACHE_EVICT).forEach(k => localStorage.removeItem(k));
    }

    localStorage.setItem(key, value);
    keys.push(key);
    localStorage.setItem(CACHE_KEY_LIST, JSON.stringify(keys));
  } catch {}
}

// ── In-flight dedup ───────────────────────────────────────────────────────────

function fetchLLMResponse(cacheKey, prompt, settings) {
  // If a request for this exact key is already in flight, reuse its Promise
  // so we don't issue a duplicate API call.
  if (pendingRequests.has(cacheKey)) return pendingRequests.get(cacheKey);

  const promise = new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "LLM_CALL", prompt, settings }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (response.error)           return reject(new Error(response.error));
      resolve(response.text);
    });
  });

  // Cache the result on success regardless of whether the tooltip is still shown.
  promise
    .then(text => cacheSet(cacheKey, text))
    .finally(() => pendingRequests.delete(cacheKey));

  pendingRequests.set(cacheKey, promise);
  return promise;
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

function removeTooltip() {
  clearTimeout(tooltipTimeout);
  const existing = document.getElementById("lingualens-tooltip");
  if (existing) existing.remove();
}

function createTooltip(span, text) {
  removeTooltip();

  const rect    = span.getBoundingClientRect();
  const tooltip = document.createElement("div");
  tooltip.id          = "lingualens-tooltip";
  tooltip.textContent = text;

  Object.assign(tooltip.style, {
    position:      "fixed",
    left:          `${rect.left + rect.width / 2}px`,
    bottom:        `${window.innerHeight - rect.top + 8}px`,
    transform:     "translateX(-50%)",
    background:    "rgba(0, 0, 0, 0.85)",
    color:         "white",
    fontSize:      "14px",
    maxWidth:      "300px",
    borderRadius:  "8px",
    padding:       "8px 12px",
    zIndex:        "9999",
    boxShadow:     "0 4px 12px rgba(0, 0, 0, 0.4)",
    lineHeight:    "1.4",
    fontFamily:    "sans-serif",
    whiteSpace:    "normal",
    wordBreak:     "break-word",
    pointerEvents: "none",
  });

  document.body.appendChild(tooltip);
  return tooltip;
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

function renderMarkdown(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

// ── Prompt ─────────────────────────────────────────────────────────────────────

function buildPrompt(clickedWord, currentLine, history) {
  const context = history.length ? history.join("\n") : "(no previous context)";
  return `The user is watching a foreign language video.

Recent subtitle context:
${context}

Current subtitle line: "${currentLine}"
Clicked word: "${clickedWord}"

Identify the language, then explain what "${clickedWord}" means in this specific context in simple English. If it's an idiom, slang, or cultural reference, explain that over a literal translation. 1-2 sentences only.`;
}

// ── Click handler ─────────────────────────────────────────────────────────────

document.addEventListener("click", async (e) => {
  const span = e.target.closest(".lingualens-word");
  if (!span) { removeTooltip(); return; }

  const clickedWord = span.dataset.word;
  const currentLine = getSubtitleText();
  const history     = [...subtitleHistory];
  const cacheKey    = makeCacheKey(clickedWord, currentLine);

  const video = document.querySelector("video");
  if (video) video.pause();

  // Cache hit — show instantly, no loading state, no API call.
  const cached = cacheGet(cacheKey);
  if (cached) {
    const tooltip = createTooltip(span, "");
    tooltip.innerHTML = renderMarkdown(cached);
    return;
  }

  // Assign a request ID before any async work. If the user clicks a different
  // word while this request is in flight, currentRequestId will have advanced
  // and the stale response will be discarded.
  const requestId = ++currentRequestId;
  const tooltip   = createTooltip(span, "...");

  chrome.storage.local.get(["provider", "apiKey", "model", "customEndpoint"], async (settings) => {
    if (!settings.apiKey) {
      if (requestId !== currentRequestId) return;
      tooltip.textContent = "Open LinguaLens settings to add your API key.";
      tooltipTimeout = setTimeout(removeTooltip, 4000);
      return;
    }

    const prompt = buildPrompt(clickedWord, currentLine, history);

    try {
      const text = await fetchLLMResponse(cacheKey, prompt, settings);

      // Two-layer stale check: request ID guards against a newer click having
      // started; tooltip identity guards against removeTooltip having run.
      if (requestId !== currentRequestId) return;
      if (document.getElementById("lingualens-tooltip") !== tooltip) return;

      tooltip.innerHTML = renderMarkdown(text);
      // No auto-dismiss — tooltip stays until the user clicks anywhere,
      // which also resumes the video.
    } catch (err) {
      if (requestId !== currentRequestId) return;
      if (document.getElementById("lingualens-tooltip") !== tooltip) return;

      tooltip.textContent = err.message === "timeout"
        ? "Request timed out. Try again."
        : `Error: ${err.message}`;
      tooltipTimeout = setTimeout(removeTooltip, 3000);
    }
  });
}, { capture: true });

// ── Observer setup ────────────────────────────────────────────────────────────

function tryAttachCaptionObserver() {
  if (captionObserver) return;

  const container = document.querySelector(".ytp-caption-window-container");
  if (!container) return;

  captionObserver = new MutationObserver(handleSubtitleChange);
  captionObserver.observe(container, {
    childList:     true,
    subtree:       true,
    characterData: true,
  });
  console.log("[LinguaLens] caption observer attached");
}

// Logs once if captions are never enabled within 30s of page/navigation load.
function scheduleCaptionWarning() {
  setTimeout(() => {
    if (!captionObserver) {
      console.log("[LinguaLens] No captions detected. Enable captions to use LinguaLens.");
    }
  }, 30000);
}

const pageObserver = new MutationObserver(tryAttachCaptionObserver);
pageObserver.observe(document.body, { childList: true, subtree: true });

scheduleCaptionWarning();

document.addEventListener("yt-navigate-finish", () => {
  lastSubtitle     = "";
  lastCompleteLine = "";
  subtitleHistory  = [];
  currentRequestId = 0;
  pendingRequests.clear();
  removeTooltip();

  if (captionObserver) {
    captionObserver.disconnect();
    captionObserver = null;
  }

  tryAttachCaptionObserver();
  scheduleCaptionWarning();
});
