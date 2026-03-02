'use strict';

const DEFAULT_SERVER = 'http://localhost:3000';
let serverUrl = DEFAULT_SERVER;

// Load saved server URL on startup
chrome.storage.local.get(['serverUrl'], (result) => {
  if (result.serverUrl) serverUrl = result.serverUrl;
});

// ─────────────────────────────────────────────
// Message handler
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'ANNOTATE') {
    annotateText(message.text)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }

  if (message.type === 'GET_SERVER_URL') {
    sendResponse({ serverUrl });
    return false;
  }

  if (message.type === 'SET_SERVER_URL') {
    serverUrl = message.url.trim().replace(/\/$/, '');
    chrome.storage.local.set({ serverUrl });
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'CHECK_SERVER') {
    checkServerHealth()
      .then(ok => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'EXTRACT_KNOWLEDGE') {
    extractKnowledge(message.text)
      .then(data => sendResponse({ success: true, ...data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ─────────────────────────────────────────────
// Fetch annotation from backend
// ─────────────────────────────────────────────
async function annotateText(text) {
  const url = `${serverUrl}/api/annotate`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(20000) // 20s timeout per chunk
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Server ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json();
}

// ─────────────────────────────────────────────
// Knowledge extraction from backend
// ─────────────────────────────────────────────
async function extractKnowledge(text) {
  const url = `${serverUrl}/api/extract-knowledge`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(25000)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Server ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json();
}

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
async function checkServerHealth() {
  const response = await fetch(`${serverUrl}/api/health`, {
    signal: AbortSignal.timeout(5000)
  });
  return response.ok;
}
