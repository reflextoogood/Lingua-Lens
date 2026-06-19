const ENDPOINTS = {
  anthropic:  "https://api.anthropic.com/v1/messages",
  openai:     "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

async function fetchLLM(prompt, settings) {
  const isAnthropic = settings.provider === "anthropic";

  const url = isAnthropic
    ? ENDPOINTS.anthropic
    : settings.provider === "custom"
      ? settings.customEndpoint
      : ENDPOINTS[settings.provider];

  const headers = isAnthropic
    ? {
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      }
    : {
        "Authorization": `Bearer ${settings.apiKey}`,
        "content-type": "application/json",
      };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("timeout");
    throw err;
  }

  clearTimeout(timeout);

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  return isAnthropic
    ? data.content[0].text
    : data.choices[0].message.content;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "LLM_CALL") return false;

  fetchLLM(message.prompt, message.settings)
    .then(text  => sendResponse({ text }))
    .catch(err  => sendResponse({ error: err.message }));

  return true; // keeps sendResponse alive until the async fetch completes
});
