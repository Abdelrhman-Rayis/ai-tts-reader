'use strict';

const DEFAULT_SERVER = 'http://localhost:3000';

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const serverInput = document.getElementById('server-url');
const btnSave = document.getElementById('btn-save');
const btnRead = document.getElementById('btn-read');

// Load saved server URL
chrome.storage.local.get(['serverUrl'], (result) => {
  const url = result.serverUrl || DEFAULT_SERVER;
  serverInput.value = url;
  checkServer(url);
});

// Check server health
async function checkServer(url) {
  statusDot.className = 'status-dot checking';
  statusText.textContent = 'Checking server...';
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      statusDot.className = 'status-dot online';
      statusText.textContent = `Server ready — ${data.model || 'claude'}`;
      btnRead.disabled = false;
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch {
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'Server offline — start it first';
    btnRead.disabled = true;
  }
}

// Save server URL
btnSave.addEventListener('click', () => {
  const url = serverInput.value.trim().replace(/\/$/, '');
  if (!url) return;
  chrome.storage.local.set({ serverUrl: url }, () => {
    chrome.runtime.sendMessage({ type: 'SET_SERVER_URL', url });
    btnSave.textContent = '✓ Saved';
    btnSave.classList.add('saved');
    setTimeout(() => {
      btnSave.textContent = 'Save';
      btnSave.classList.remove('saved');
    }, 1500);
    checkServer(url);
  });
});

// Read this page button
btnRead.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: 'START_READING' }, (response) => {
      if (chrome.runtime.lastError) {
        // Content script might not be injected yet — inject manually
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          files: ['content/content.js']
        }).then(() => {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'START_READING' });
        });
      }
    });
    window.close();
  });
});
