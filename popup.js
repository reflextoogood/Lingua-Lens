const MODEL_DEFAULTS = {
  openrouter: "meta-llama/llama-3.1-8b-instruct:free",
  openai:     "gpt-4o-mini",
  anthropic:  "claude-haiku-4-5-20251001",
  custom:     "",
};

const providerEl        = document.getElementById("provider");
const apiKeyEl          = document.getElementById("api-key");
const modelEl           = document.getElementById("model");
const customEndpointRow = document.getElementById("custom-endpoint-row");
const customEndpointEl  = document.getElementById("custom-endpoint");
const saveBtn           = document.getElementById("save-btn");
const statusEl          = document.getElementById("status");

function syncProviderUI() {
  const p = providerEl.value;
  modelEl.placeholder = MODEL_DEFAULTS[p] || "";
  customEndpointRow.style.display = p === "custom" ? "block" : "none";
}

providerEl.addEventListener("change", syncProviderUI);

chrome.storage.local.get(["provider", "apiKey", "model", "customEndpoint"], (saved) => {
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
