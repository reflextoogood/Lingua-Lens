const MODEL_DEFAULTS = {
  openrouter: "openrouter/free",
  openai:     "gpt-4o-mini",
  anthropic:  "claude-haiku-4-5-20251001",
  grok:       "grok-2-1212",
  groq:       "llama-3.1-70b-versatile",
  ollama:     "llama2",
  custom:     "",
};

const providerEl        = document.getElementById("provider");
const apiKeyEl          = document.getElementById("api-key");
const modelEl           = document.getElementById("model");
const customEndpointRow = document.getElementById("custom-endpoint-row");
const customEndpointEl  = document.getElementById("custom-endpoint");
const saveBtn           = document.getElementById("save-btn");
const statusEl          = document.getElementById("status");

let savedProvider = null;
let savedSettings = {};

function syncProviderUI() {
  const p = providerEl.value;
  modelEl.placeholder = MODEL_DEFAULTS[p] || "";
  customEndpointRow.style.display = p === "custom" ? "block" : "none";

  // If user switches to a different provider, clear the fields
  // (settings are provider-specific, can't reuse API key between providers)
  if (p !== savedProvider) {
    apiKeyEl.value = "";
    modelEl.value = "";
    customEndpointEl.value = "";
  } else {
    // If user switches back to the saved provider, restore the saved settings
    apiKeyEl.value = savedSettings.apiKey || "";
    modelEl.value = savedSettings.model || "";
    customEndpointEl.value = savedSettings.customEndpoint || "";
  }
}

providerEl.addEventListener("change", syncProviderUI);

chrome.storage.local.get(["provider", "apiKey", "model", "customEndpoint"], (saved) => {
  savedProvider = saved.provider;
  savedSettings = { apiKey: saved.apiKey, model: saved.model, customEndpoint: saved.customEndpoint };

  if (saved.provider)       providerEl.value       = saved.provider;
  if (saved.apiKey)         apiKeyEl.value         = saved.apiKey;
  if (saved.model)          modelEl.value          = saved.model;
  if (saved.customEndpoint) customEndpointEl.value = saved.customEndpoint;
  syncProviderUI();
});

saveBtn.addEventListener("click", () => {
  const p = providerEl.value;
  chrome.storage.local.set({
    provider:       p,
    apiKey:         apiKeyEl.value.trim(),
    model:          modelEl.value.trim() || MODEL_DEFAULTS[p],
    customEndpoint: customEndpointEl.value.trim(),
  }, () => {
    statusEl.textContent = "Saved ✓";
    setTimeout(() => { statusEl.textContent = ""; }, 2000);
  });
});
