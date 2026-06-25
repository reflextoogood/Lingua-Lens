# LinguaLens Development Guide

This document captures the architectural decisions, technical explanations, and rationale behind LinguaLens v1.0. It serves as both a reference for future maintenance and a learning resource for Chrome extension development.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Day-by-Day Build Process](#day-by-day-build-process)
3. [Architecture & Design Decisions](#architecture--design-decisions)
4. [Key Technical Concepts](#key-technical-concepts)
5. [Testing & Verification](#testing--verification)
6. [Known Limitations & Future Work](#known-limitations--future-work)

---

## Project Overview

**LinguaLens** is a Chrome extension that helps users learn foreign languages while watching YouTube videos with subtitles. When a user clicks any word in the subtitle, a contextual explanation appears in a tooltip — not a dictionary translation, but a real explanation that handles idioms, slang, and cultural references.

### Core Features

- Click any word in YouTube subtitles for instant contextual explanation
- Automatic language detection from subtitle text
- Works with any language worldwide (tested: Hindi, Urdu, Persian, English, Spanish, etc.)
- Provider-agnostic: OpenRouter, OpenAI, Anthropic, Grok, Groq, Ollama, or custom OpenAI-compatible endpoints
- Smart localStorage caching with FIFO eviction
- Pauses video on click so users have time to read
- Smooth dark-themed settings UI
- Zero external dependencies — vanilla JavaScript, Manifest V3

---

## Day-by-Day Build Process

### Day 1: Chrome Extension Skeleton

**Goal:** Build a valid extension that loads on YouTube and logs to console.

**Files Created:**
- `manifest.json` — Extension identity card
- `content.js` — Script injected into YouTube pages
- `background.js` — Service worker (MV3 requirement)
- `popup.html` / `popup.js` — Settings UI

**Key Concepts Introduced:**

**Manifest V3** is the current Chrome extension standard (MV2 deprecated). The manifest declares:
- `manifest_version: 3` — use the latest standard
- `permissions` — what the extension is allowed to access (e.g., `storage`)
- `host_permissions` — external APIs the extension can reach via fetch
- `content_scripts` — JavaScript injected into web pages
- `background.service_worker` — background script for heavy lifting

**Content Script vs Service Worker:**
- **Content script** (`content.js`): Runs inside YouTube pages, has access to the DOM, can read/manipulate subtitles
- **Service worker** (`background.js`): Runs in an isolated background context, no DOM access, handles API calls and handles CORS issues that content scripts can't solve

**Why separate?** The content script can fetch from YouTube (same origin), but if it fetches from external APIs like Anthropic, it hits CORS restrictions. The service worker runs under different CORS rules, so it can make those cross-origin calls safely.

**Lesson:** `console.log()` in a content script appears in the page's DevTools Console, not in the extension's background console. To see background.js logs, go to `chrome://extensions` → find LinguaLens → click "Service Worker" to open its DevTools.

---

### Day 2: Real-Time Subtitle Interception

**Goal:** Watch YouTube subtitle DOM for changes and log every line in real time.

**Key Concepts:**

**MutationObserver** is the browser API for watching DOM changes. Unlike event listeners (which only fire for specific DOM events), MutationObserver fires whenever the DOM changes.

```javascript
const observer = new MutationObserver(handleSubtitleChange);
observer.observe(container, {
  childList: true,    // fire on child elements added/removed
  subtree: true,      // watch all descendants, not just direct children
  characterData: true // fire on text node changes
});
```

**Why not regular event listeners?** YouTube's subtitle rendering is DOM manipulation, not a user interaction. There's no "subtitlechanged" event. MutationObserver is the only way to watch the DOM itself change.

**Two-Observer Pattern:**
1. **PageObserver** — watches `document.body` broadly. Its only job is to detect when the `.ytp-caption-window-container` element appears (YouTube builds this asynchronously)
2. **CaptionObserver** — narrowly watches just the caption container for subtitle text changes

Watching `document.body` at full depth would fire thousands of callbacks per minute on YouTube. The two-observer pattern keeps the hot path (subtitle reading) efficient.

**YouTube is a Single Page App (SPA):** When users navigate between videos, the page doesn't reload — JavaScript history APIs handle navigation. Watching for the `yt-navigate-finish` custom event lets us reset state and reattach observers when a new video starts.

---

### Day 3: Word-Level Clickability & History Tracking

**Goal:** Wrap individual words in clickable spans, track subtitle history, log on click.

**Key Concepts:**

**Word Wrapping:**
```javascript
const html = text.split(/(\s+)/).map(token => {
  if (/^\s+$/.test(token)) return token; // preserve whitespace
  const cleanWord = token.replace(/[^\p{L}\p{N}\p{M}\p{Cf}]/gu, "");
  return `<span class="lingualens-word" data-word="${cleanWord}">${token}</span>`;
}).join("");
segment.innerHTML = html;
```

Why this approach?
- Split on whitespace boundaries (`/(\s+)/`), preserving the whitespace in the resulting array
- For each token, strip punctuation to create a clean `data-word` attribute
- Keep the original token visible (with punctuation) so the subtitle looks natural
- Wrap in a span so clicks can be detected

**Unicode Regex with `\p` properties:**
- `\p{L}` — any letter in any script (140,000+ Unicode letters)
- `\p{N}` — any number
- `\p{M}` — any combining mark (vowel signs, diacritics, tone marks)
- `\p{Cf}` — format characters (zero-width joiners used in Urdu/Persian)
- `u` flag required to use `\p` properties

The regex `[^\p{L}\p{N}\p{M}\p{Cf}]` means "remove anything that's NOT a letter, number, mark, or format character" — this preserves word structure while stripping punctuation.

**Real-World Example (Hindi):**
- Original: `"राधा,"`
- Split: `["राधा", ","]`
- Cleaned: `cleanWord = "राधा"` (comma stripped)
- HTML: `<span class="lingualens-word" data-word="राधा">राधा,</span>`

**Infinite Loop Prevention:**
When you set `segment.innerHTML = html`, you're modifying the DOM, which triggers the MutationObserver again. To prevent a loop:
```javascript
if (isRewrapping) return; // exit early if we're in the middle of wrapping
isRewrapping = true;
wrapWordsInSegments();
isRewrapping = false;
```

This works because `getSubtitleText()` ignores HTML tags and reads only text content. Your own mutations produce the same text as before, so `text === lastSubtitle` catches it on the second call.

**Subtitle History:**
```javascript
if (lastCompleteLine && !newText.startsWith(lastCompleteLine)) {
  subtitleHistory.push(lastCompleteLine);
  if (subtitleHistory.length > 4) subtitleHistory.shift();
}
```

Detects a complete line by checking if new text **starts with** the previous line. If not, the previous line was complete.

- `"राधा" → "राधा की" → "राधा की बात"` — all start with the previous, same line building
- `"नमस्ते दुनिया"` — doesn't start with `"राधा की बात"`, so previous line was complete

**`Array.shift()`** removes the first (oldest) element. This maintains a rolling window of the last 4 lines — useful context for the LLM to understand what the user was watching.

---

### Day 4: LLM API Integration & Tooltips

**Goal:** Call an LLM API on word click and display the explanation in a tooltip.

**Key Concepts:**

**Provider-Agnostic API Design:**

Different LLM providers have slightly different API formats:

| Aspect | Anthropic | OpenAI-Compatible |
|---|---|---|
| **Auth header** | `x-api-key: sk-...` | `Authorization: Bearer sk-...` |
| **Version header** | `anthropic-version: 2023-06-01` | (none required) |
| **Browser header** | `anthropic-dangerous-direct-browser-access: true` | (none required) |
| **Response path** | `data.content[0].text` | `data.choices[0].message.content` |

Solution: In `background.js`, branch on one boolean:
```javascript
if (settings.provider === "anthropic") {
  // Use Anthropic format
} else {
  // Use OpenAI-compatible format (covers OpenAI, OpenRouter, Grok, Groq, Ollama)
}
```

All other providers copy OpenAI's API design, so we only need two codepaths.

**Why use a service worker as a fetch proxy?** The content script could fetch directly, but would hit CORS errors. The service worker runs with elevated permissions and can fetch from any host declared in `host_permissions`. This is the standard pattern in Chrome extensions.

**Fixed vs Absolute Positioning for Tooltips:**

```javascript
tooltip.style.position = "fixed";
tooltip.style.left = `${rect.left + rect.width / 2}px`;
tooltip.style.bottom = `${window.innerHeight - rect.top + 8}px`;
```

- `getBoundingClientRect()` returns viewport-relative coordinates (0,0 at viewport top-left)
- `position: fixed` also positions relative to the viewport
- They're in the same coordinate space, so rect values work directly
- If we used `position: absolute`, we'd need to account for ancestor offsets and scroll position — much more complex

**Markdown Rendering:**
The LLM returns responses with markdown (`**bold**`, `*italic*`). Naive approach: set `innerHTML` directly. **Bad** — if response contains `<script>` tags, they execute (XSS).

Safe approach:
```javascript
function renderMarkdown(text) {
  return text
    .replace(/&/g, "&amp;")       // escape ampersands FIRST
    .replace(/</g, "&lt;")         // escape < to prevent </script>
    .replace(/>/g, "&gt;")         // escape >
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") // then apply markdown
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}
tooltip.innerHTML = renderMarkdown(text);
```

Escape raw text first, then apply markdown. This way any `<` in the response becomes `&lt;` before we inject HTML, preventing injection.

**Request ID Guard for Stale Responses:**

```javascript
const requestId = ++currentRequestId;
const tooltip   = createTooltip(span, "...");
// ... API call starts ...
const text = await fetchLLMResponse(...);
if (requestId !== currentRequestId) return; // discard if user clicked a different word
```

Scenario: User clicks "राधा" (request 1), API is slow. User clicks "कृष्ण" (request 2) while waiting. Request 1 resolves → checks `1 !== 2` → true → discards response. Request 2 resolves → checks `2 !== 2` → false → renders correctly.

---

### Day 5: Caching & Edge Case Hardening

**Goal:** Cache explanations to avoid repeat API calls, handle edge cases gracefully.

**Key Concepts:**

**Why cache by `word + line`, not just `word`?**

The word "काम" (kaam) in Hindi means:
- "work" in a line about daily life
- "desire" in a romantic song

Same spelling, different meanings based on context. Caching by word alone would silently return wrong answers.

Cache key: `lingualens:${word}:${line}` ensures each explanation is tied to its context.

**FIFO Cache Eviction:**
```javascript
const CACHE_MAX = 2000;
const CACHE_EVICT = 200; // 10%

if (keys.length >= CACHE_MAX) {
  keys.splice(0, CACHE_EVICT).forEach(k => localStorage.removeItem(k));
}
```

FIFO (First-In-First-Out) evicts the oldest entries when the cache fills. It's good enough here because:
- Access pattern is roughly sequential (watch a video, look up words in order)
- Old lookups from hours ago are unlikely to be needed again
- Implementation is trivial
- ~2000 entries at ~300 bytes each = 600KB — well within localStorage limits

**When FIFO would NOT be good:** A web browser page cache (you visit 10 tabs repeatedly) would benefit from LRU (Least Recently Used) since frequently-accessed items should stay. But for a linear watching experience, FIFO is simpler and sufficient.

**In-Flight Request Dedup:**
```javascript
const pendingRequests = new Map(); // cacheKey → Promise<string>

if (pendingRequests.has(cacheKey)) {
  return pendingRequests.get(cacheKey); // reuse existing promise
}
```

If user clicks the same word twice before the first API call completes, don't fire a duplicate request. Reuse the Promise so both clicks wait for the same response.

**Edge Cases Handled:**

1. **Subtitle changes while tooltip is loading:** Request ID check prevents a stale response from overwriting the current tooltip
2. **Rapid double-clicks:** In-flight dedup prevents duplicate API calls
3. **No captions enabled:** `scheduleCaptionWarning()` logs once after 30s: `"[LinguaLens] No captions detected. Enable captions to use LinguaLens."`
4. **Extension works across SPA navigation:** `yt-navigate-finish` event resets state and re-attaches observers
5. **Video pause:** Direct `document.querySelector("video").pause()` — YouTube's subtitle overlay blocks clicks from reaching the player
6. **No API key:** Graceful tooltip message prompts user to configure settings

---

## Architecture & Design Decisions

### Content Script Only Approach (No Background API Calls)

**Why content.js doesn't call the LLM directly:**

Content scripts run with the same CORS restrictions as web pages. Fetch to `https://api.anthropic.com/*` would fail with CORS error.

**Why we use a service worker proxy:**

Service workers run with different CORS rules. The manifest's `host_permissions` lets them fetch from any declared origin. All LLM API requests go through the service worker, which handles:
- Detecting provider format (Anthropic vs OpenAI-compatible)
- Adding correct auth headers
- Parsing responses
- Error handling with proper error messages

**Data flow:**
```
User clicks word in YouTube
  ↓
content.js detects click
  ↓
content.js reads from chrome.storage.local (API key, provider, model)
  ↓
content.js sends message to background service worker
  ↓
background.js makes fetch call to LLM provider
  ↓
response comes back, background.js sends to content.js
  ↓
content.js displays tooltip with explanation
```

### Why Provider Settings are Provider-Specific

**Current behavior:**
- User saves Anthropic key + model
- User closes and reopens popup
- Popup loads with Anthropic provider and the saved key
- User switches dropdown to "OpenAI" → API key field clears
- User switches back to "Anthropic" → saved key reappears

**Why not allow mixing?**

An Anthropic API key won't work with OpenAI's API, and vice versa. Clearing on provider switch prevents the user from accidentally saving an Anthropic key under the "OpenAI" provider.

**Implementation:**
```javascript
let savedProvider = null;
let savedSettings = {};

if (p !== savedProvider) {
  // Different provider, clear fields
  apiKeyEl.value = "";
} else {
  // Same provider, restore saved settings
  apiKeyEl.value = savedSettings.apiKey || "";
}
```

### Why `rgba()` Borders Instead of Solid Colors

On a dark background like `#1a1a1f`:
- Solid border `#333340` looks like a colored line (its own hue)
- `rgba(255, 255, 255, 0.08)` overlay adapts to any background

The visual effect: borders feel like they're *part of the surface*, not drawn on top. This is why all modern dark UIs (VS Code, Figma, Linear) use rgba overlays — they work with any background color.

### Why `box-shadow` for Focus States, Not `outline`

Default browser outline:
```css
outline: 2px solid blue; /* hard edge, looks like a debug marker */
```

Our soft glow:
```css
border-color: rgba(124, 92, 247, 0.65);
box-shadow: 0 0 0 3px rgba(124, 92, 247, 0.12);
```

- The border changes to accent color (immediate, subtle)
- `box-shadow: 0 0 0 3px` creates a sharp ring with 3px spread
- Low opacity (`0.12`) makes it feel diffuse, like a luminous halo
- `transition: 150ms ease` animates the state change rather than snapping

Result: feels responsive and intentional, not jarring.

---

## Key Technical Concepts

### Unicode Categories with `\p{...}` Regex

`\p{L}`, `\p{N}`, `\p{M}`, `\p{Cf}` are Unicode property escapes. They require the `u` flag.

| Category | Matches | Example |
|---|---|---|
| `\p{L}` | Any letter in any script | `a`, `आ`, `ა`, `ع` |
| `\p{N}` | Any number | `5`, `५`, `٥` |
| `\p{M}` | Combining marks (diacritics, tone marks, etc.) | `◌्` (virama), `◌ि` (vowel sign) |
| `\p{Cf}` | Format characters | ZWNJ (U+200C), ZWJ (U+200D) |

**Why `\p{M}` matters:**

Hindi uses Devanagari script:
- `क` (consonant) — category `L`
- `्` (virama/halant) — category `Mn` (nonspacing mark)
- `ु` (vowel sign) — category `Mc` (spacing mark)

Word: क्+ य + ु + क्+ ि = क्योंकि (kyonki = because)

Without `\p{M}`, the virama and vowel signs are stripped, leaving क य क = incorrect.

**Why `\p{Cf}` matters:**

Urdu/Persian use Zero-Width Non-Joiner (ZWNJ) to control letter shaping:
- **With ZWNJ:** letter renders in final form
- **Without ZWNJ:** letter renders in different form

Removing ZWNJ changes the word's meaning or readability.

### Why `localStorage` for Caching, Not `IndexedDB`

**Tradeoffs:**

| Aspect | localStorage | IndexedDB |
|---|---|---|
| **Size** | 5-10MB | 50MB+ |
| **Access** | Synchronous (blocks) | Asynchronous |
| **Structure** | Key-value strings | Object store |
| **Complexity** | Trivial | More involved |

For LinguaLens: localStorage is enough (2000 entries × 300 bytes ≈ 600KB). Sync access doesn't matter since we read cache during click handling, not during load. IndexedDB would be overkill.

### Why `chrome.storage.local`, Not `localStorage`

**localStorage:**
- Scoped to the web page origin
- YouTube's script can read it
- Security issue: your API key would be accessible to YouTube's JS

**chrome.storage.local:**
- Belongs to the extension, isolated from all web pages
- Only the extension's code can access it
- Persists across browser restarts
- Perfect for storing sensitive data

---

## Testing & Verification

### Manual Testing Checklist

- [ ] **Day 1:** Open YouTube, open DevTools console, verify "LinguaLens loaded" appears
- [ ] **Day 2:** Enable captions, verify subtitle lines log in real time as video plays
- [ ] **Day 3:** Click words, verify clicked word + current line + history appear in console
- [ ] **Day 4:** With API key configured, click a word, verify tooltip appears with explanation within 1-2 seconds
- [ ] **Day 5:** Click same word twice, verify second click responds instantly from cache
- [ ] **Rapid clicks:** Click multiple different words in quick succession, verify tooltips don't show stale explanations
- [ ] **Video navigation:** Go to a different YouTube video (SPA nav, no full reload), verify LinguaLens still works
- [ ] **Provider switching:** Save OpenRouter key, switch popup to OpenAI, verify key field clears; switch back to OpenRouter, verify key reappears
- [ ] **No captions:** Open video without captions, wait 30s, verify console shows "No captions detected" message exactly once

### Tested Languages

- **Hindi** (Devanagari) ✅
- **English** (Latin) ✅
- **Spanish** (Latin with diacritics) ✅
- **Urdu** (Arabic script with ZWNJ) ✅ (after adding `\p{Cf}`)

### Tested Providers

- **OpenRouter** ✅
- **OpenAI** ✅
- **Anthropic** ✅

---

## Known Limitations & Future Work

### Current Limitations

1. **Explanations always in English** — LLM is always asked to explain in English. Future: let users choose explanation language.

2. **No audio transcription** — only works with existing YouTube captions. We could add Whisper integration for non-captioned videos, but that's a separate project.

3. **Fixed 1-2 sentence limit** — prompt hard-codes this. Future: let users configure explanation depth.

4. **localStorage size limit** — caches up to 2000 explanations (~600KB). Very heavy users might hit this. Future: implement smarter eviction (LRU by access time).

5. **No offline support** — requires internet for API calls. Ollama support partially addresses this (local LLM), but still requires the Ollama server running.

6. **No user analytics** — we don't know which words users struggle with. This is intentional (privacy-first), but future versions could offer opt-in analytics.

### Potential Improvements

1. **Per-language defaults** — detect user's YouTube language and preset the explanation language
2. **Keyboard shortcuts** — Alt+Click for alternative explanations, Shift+Click for word etymology
3. **Pronunciation guide** — add audio pronunciation from Google Translate API
4. **Anki integration** — export clicked words to a study deck
5. **User feedback loop** — rate explanations, help improve prompt over time
6. **Batch processing** — let users highlight multiple lines and generate flashcards
7. **Subtitle download** — save subtitle tracks with annotations

### Architecture Decisions That Could Change

1. **Content script word wrapping** — Currently wraps on every mutation. Could optimize to wrap only new segments.
2. **Request ID mechanism** — Currently uses a simple counter. Could use UUIDs for multi-tab scenarios.
3. **Cache eviction** — Currently FIFO. Could become LRU if users report hitting size limits.

---

## Code Quality Notes

### No External Dependencies

The entire extension is vanilla JavaScript. No npm packages, no build step, no transpilation. This keeps it:
- Fast to load
- Small (all code is essential)
- Easy to audit (no supply chain risk)
- Easy to modify and extend

### Error Handling Philosophy

- **Silent failures where possible** — if subtitle parsing fails, just log and continue
- **User-visible errors only for actions** — if API call fails, show tooltip message
- **Never let errors crash the extension** — all promises have `.catch()`, all storage calls check for errors

### Code Comments

Comments explain *why*, not *what*. Good comment:
```javascript
// Guard: user may have clicked a different word while we were waiting.
if (requestId !== currentRequestId) return;
```

Bad comment:
```javascript
// Check if request ID matches current request ID
if (requestId !== currentRequestId) return;
```

The code already says "check if request ID matches" — a comment should explain the *reason* (stale response guard).

---

## References

- [Chrome Extension Docs](https://developer.chrome.com/docs/extensions/)
- [MutationObserver API](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver)
- [Unicode Property Escapes](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Regular_expressions/Unicode_character_class_escape)
- [chrome.storage API](https://developer.chrome.com/docs/extensions/reference/storage/)
- [Manifest V3 Migration Guide](https://developer.chrome.com/docs/extensions/mv3/)

---

*Last updated: June 2026*
