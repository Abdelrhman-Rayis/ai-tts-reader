/**
 * AI TTS Reader — Content Script
 * Pipeline: Extract → Instant rule-based narration → Speak immediately
 *            ↳ AI enhances upcoming sentences silently in background
 */
(function () {
  'use strict';

  // Prevent double-injection on the same page load
  if (window.__ttsReaderActive) return;

  // ─────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────
  const state = {
    sentences: [],       // [{ text, rate, pause_after, important, type, paraEl }]
    index: -1,           // current sentence index
    playing: false,
    paused: false,
    speedMultiplier: 1.0,
    voices: [],
    preferredVoice: null,
    playerEl: null,
    // Word-level highlighting
    wordState: {
      wrappedEl: null,       // which paraEl currently has words wrapped in spans
      spans: [],             // flat array of .tts-word spans for that element
      paraWordOffset: 0,     // how many DOM words we've advanced within wrappedEl
      activeSpan: null,      // the span currently underlined
      timingInterval: null   // interval driving timing-based word advance
    },
    knowledgeHighlights: [], // { el, cssClass, badge } for cleanup
    // Hover-to-read
    hoverEl: null,           // currently hovered DOM element
    hoverTooltipEl: null,    // the floating tooltip pill element
    hoverListenersAdded: false
  };

  // Session counter — incremented on every main() call.
  // Background tasks (upgradeWithAI, runKnowledgeExtraction) capture their
  // session number and bail out early if a newer session has started,
  // preventing stale content from a previous page polluting the current read.
  let _session = 0;

  // ─────────────────────────────────────────────
  // Navigation / BFCache guards
  // When the user navigates away (including SPA pushState navigations that
  // don't unload the content script), tear down any active session so the
  // old script can't keep speaking or mutating state for the new page.
  // ─────────────────────────────────────────────
  function teardown() {
    _session++;                    // invalidates all running background tasks
    speechSynthesis.cancel();
    state.playing = false;
    state.paused = false;
    state.sentences = [];
    state.index = -1;
    resetWordState();
    clearKnowledgeHighlights();
    clearHighlight();
    hideHoverTooltip();
    if (state.playerEl) { state.playerEl.remove(); state.playerEl = null; }
    window.__ttsReaderActive = false;
  }

  // pagehide fires on both normal navigation AND BFCache entry
  window.addEventListener('pagehide', teardown);

  // pageshow fires when a BFCached page is restored — reset so it can't resume
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) teardown();
  });

  // ─────────────────────────────────────────────
  // Listen for messages from popup / service worker
  // ─────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'START_READING') {
      if (!window.__ttsReaderActive) {
        // First launch on this page
        window.__ttsReaderActive = true;
        main();
      } else if (state.paused) {
        // Reader is open but paused — resume
        togglePlayPause();
      }
      // If already playing, do nothing (avoid double-start or toggling to pause)
    }
    if (msg.type === 'STOP_READING') {
      stopAndClose();
    }
  });

  // ─────────────────────────────────────────────
  // 1. ARTICLE EXTRACTION
  // Returns array of { el: DOMElement, text: string }
  // ─────────────────────────────────────────────
  function extractArticle() {
    // Tags to skip entirely
    const SKIP = new Set([
      'SCRIPT', 'STYLE', 'NAV', 'HEADER', 'FOOTER', 'ASIDE',
      'BUTTON', 'SELECT', 'OPTION', 'FORM', 'FIGURE', 'NOSCRIPT',
      'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'SVG', 'TIME'
    ]);

    // Try to find the main content area
    const selectors = [
      'article',
      'main',
      '[role="main"]',
      '.post-content',
      '.article-body',
      '.entry-content',
      '.content-body',
      '#article-body',
      '#content',
      '.story-body'
    ];

    let root = null;
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 300) {
        root = el;
        break;
      }
    }

    // Fallback: score all block elements by paragraph density
    // Exclude elements inside navigation using cheap selector checks only
    if (!root) {
      let best = null, bestScore = 0;
      document.querySelectorAll('div, section').forEach(el => {
        if (el.closest('nav, header, footer, aside, [role="navigation"], [role="banner"]')) return;
        const ps = el.querySelectorAll('p');
        const score = Array.from(ps).reduce((acc, p) => acc + p.innerText.trim().length, 0);
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      });
      root = best || document.body;
    }

    // Collect block elements with meaningful text
    const blocks = [];
    const seen = new Set();
    const blockTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'LI', 'BLOCKQUOTE', 'TD', 'TH']);

    function walk(el) {
      if (SKIP.has(el.tagName)) return;
      if (seen.has(el)) return;
      // Skip navigation roles (cheap attribute check — no forced reflow)
      if (el.getAttribute('role') === 'navigation' ||
        el.getAttribute('role') === 'banner' ||
        el.getAttribute('role') === 'complementary') return;

      if (blockTags.has(el.tagName)) {
        const text = el.innerText.trim();
        if (text.length > 20 && !seen.has(el)) {
          seen.add(el);
          blocks.push({ el, text, tag: el.tagName });
        }
      } else {
        for (const child of el.children) {
          walk(child);
        }
      }
    }

    walk(root);

    // Filter: remove nav-like short items and duplicates
    return blocks.filter(b => {
      if (b.text.length < 15) return false;
      // Skip blocks inside any nav/menu ancestor
      if (b.el.closest('nav, menu, [role="navigation"], [role="menubar"]')) return false;
      // Skip very short LI items that look like menu entries
      if (b.tag === 'LI' && b.text.length < 40 && b.el.closest('nav, menu, header')) return false;
      return true;
    });
  }

  // ─────────────────────────────────────────────
  // Find the "natural" start sentence index.
  // Prefers the first H1 block; falls back to index 0.
  // This prevents bookmarks from re-starting reading in nav items.
  // ─────────────────────────────────────────────
  function findNaturalStartIndex(sentences) {
    // Find the first sentence associated with an H1 element
    for (let i = 0; i < sentences.length; i++) {
      if (sentences[i].paraTag === 'H1') return i;
    }
    // Fallback: first sentence that is a heading (H2/H3) if no H1
    for (let i = 0; i < sentences.length; i++) {
      if (['H2', 'H3'].includes(sentences[i].paraTag)) return i;
    }
    return 0;
  }

  // ─────────────────────────────────────────────
  // 2. TEXT CHUNKING
  // Split blocks into chunks ≤ 2500 chars for API calls
  // ─────────────────────────────────────────────
  function chunkBlocks(blocks, maxLen = 2500) {
    const chunks = []; // [{ text, blockRange: [start, end] }]
    let current = '';
    let startIdx = 0;

    blocks.forEach((block, i) => {
      const separator = current.length > 0 ? '\n\n' : '';
      if (current.length + separator.length + block.text.length > maxLen && current.length > 0) {
        chunks.push({ text: current, startIdx, endIdx: i - 1 });
        current = block.text;
        startIdx = i;
      } else {
        current += separator + block.text;
      }
    });

    if (current.trim()) {
      chunks.push({ text: current, startIdx, endIdx: blocks.length - 1 });
    }

    return chunks;
  }

  // ─────────────────────────────────────────────
  // 3. AI ANNOTATION
  // Send chunk to backend, get annotated sentences
  // ─────────────────────────────────────────────
  async function annotatechunk(text) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'ANNOTATE', text }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.success) {
          reject(new Error(response?.error || 'Annotation failed'));
          return;
        }
        resolve(response.data.sentences || []);
      });
    });
  }

  // ─────────────────────────────────────────────
  // 3b. RULES ENGINE — zero-latency normalization
  //     Runs instantly, no server needed
  // ─────────────────────────────────────────────

  function numberToWords(n) {
    if (n === null || n === undefined || isNaN(n) || !isFinite(n)) return String(n);
    if (n < 0) return 'negative ' + numberToWords(-n);

    // Handle decimals: "3.97" → "three point nine seven"
    const s = String(n);
    if (s.includes('.')) {
      const [intStr, decStr] = s.split('.');
      const intWords = numberToWords(parseInt(intStr, 10));
      const decWords = decStr.split('').map(d => ONES[parseInt(d, 10)] || 'zero').join(' ');
      return intWords + ' point ' + decWords;
    }

    n = Math.floor(n);
    if (n === 0) return 'zero';
    if (n < 20) return ONES[n];
    if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
    if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numberToWords(n % 100) : '');
    if (n < 1e6) return numberToWords(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + numberToWords(n % 1000) : '');
    if (n < 1e9) return numberToWords(Math.floor(n / 1e6)) + ' million' + (n % 1e6 ? ' ' + numberToWords(n % 1e6) : '');
    return numberToWords(Math.floor(n / 1e9)) + ' billion' + (n % 1e9 ? ' ' + numberToWords(n % 1e9) : '');
  }

  const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

  function normalizeForSpeech(text) {
    return text
      // ── Strip noise ──
      .replace(/\[\d+(?:,\s*\d+)*\]/g, '')               // [1], [1,2]
      .replace(/\(\s*[A-Z][a-z]+(?:\s+et al\.)?,?\s*\d{4}[a-z]?\s*\)/g, '') // (Smith 2024)
      .replace(/\(p\.\s*\d+(?:–\d+)?\)/g, '')            // (p. 42)
      .replace(/https?:\/\/\S+/g, '')                     // URLs

      // ── Symbols → words ──
      .replace(/—|–/g, ', ')                              // em/en dash
      .replace(/\s&\s/g, ' and ')
      .replace(/&amp;/g, 'and')
      .replace(/\s@\s/g, ' at ')
      .replace(/\s~\s?/g, ' approximately ')
      .replace(/≈/g, 'approximately ')
      .replace(/≥/g, 'at least ')
      .replace(/≤/g, 'at most ')
      .replace(/→/g, 'to ')
      .replace(/\s\/\s/g, ' or ')                         // a / b → a or b (not ratios)
      .replace(/#(\d+)/g, (_, n) => 'number ' + numberToWords(parseInt(n)))

      // ── Currency ──
      .replace(/\$(\d+(?:\.\d+)?)(B|M|K)?\+?/gi, (_, n, sfx) => {
        const w = { B: 'billion', M: 'million', K: 'thousand' };
        const num = parseFloat(n);
        return numberToWords(num) + (sfx ? ' ' + w[sfx.toUpperCase()] : '') + ' dollars';
      })
      .replace(/(\d+(?:\.\d+)?)(B|M|K)\+?\s*dollars/gi, (_, n, sfx) => {
        const w = { B: 'billion', M: 'million', K: 'thousand' };
        return numberToWords(parseFloat(n)) + ' ' + w[sfx.toUpperCase()] + ' dollars';
      })

      // ── Percentages (handle ranges like 2-8% first) ──
      .replace(/(\d+\.?\d*)\s*[-–]\s*(\d+\.?\d*)%/g, (_, a, b) =>
        numberToWords(parseFloat(a)) + ' to ' + numberToWords(parseFloat(b)) + ' percent')
      .replace(/(\d+\.?\d*)%/g, (_, n) => numberToWords(parseFloat(n)) + ' percent')

      // ── Large number shorthands before year detection ──
      .replace(/\b(\d+(?:\.\d+)?)(B|M|K)\+?/gi, (_, n, sfx) => {
        const w = { B: 'billion', M: 'million', K: 'thousand' };
        return numberToWords(parseFloat(n)) + ' ' + w[sfx.toUpperCase()];
      })

      // ── Years (20xx, 19xx) ──
      .replace(/\b(20)(\d{2})\b/g, (_, __, yy) => {
        const y = parseInt(yy);
        if (y === 0) return 'two thousand';
        if (y < 10) return 'twenty oh ' + numberToWords(y);
        return 'twenty ' + numberToWords(y);
      })
      .replace(/\b(19)(\d{2})\b/g, (_, __, yy) => {
        const y = parseInt(yy);
        if (y < 10) return 'nineteen oh ' + numberToWords(y);
        return 'nineteen ' + numberToWords(y);
      })

      // ── Remaining plain numbers ──
      .replace(/\b(\d{1,3}(?:,\d{3})+(?:\.\d+)?)\b/g, (_, n) => numberToWords(parseFloat(n.replace(/,/g, ''))))
      .replace(/\b(\d+\.\d+)\b/g, (_, n) => {
        const [int, dec] = n.split('.');
        return numberToWords(parseInt(int)) + ' point ' + dec.split('').map(d => numberToWords(parseInt(d))).join(' ');
      })
      .replace(/\b(\d+)\b/g, (_, n) => numberToWords(parseInt(n)))

      // ── Abbreviations ──
      .replace(/\be\.g\.\s*/g, 'for example, ')
      .replace(/\bi\.e\.\s*/g, 'that is, ')
      .replace(/\betc\.\s*/g, 'and so on ')
      .replace(/\bvs\.\s*/g, 'versus ')
      .replace(/\bDr\.\s+/g, 'Doctor ')
      .replace(/\bProf\.\s+/g, 'Professor ')
      .replace(/\bMr\.\s+/g, 'Mister ')
      .replace(/\bMrs\.\s+/g, 'Missus ')
      .replace(/\bapprox\.\s*/g, 'approximately ')
      .replace(/\bca\.\s*/g, 'approximately ')

      // ── Domain-specific acronyms ──
      .replace(/\bTTS\b/g, 'text to speech')
      .replace(/\bMVP\b/g, 'minimum viable product')
      .replace(/\bGTM\b/g, 'go to market')
      .replace(/\bCAGR\b/g, 'compound annual growth rate')
      .replace(/\bSAM\b/g, 'serviceable addressable market')
      .replace(/\bTAM\b/g, 'total addressable market')
      .replace(/\bSOM\b/g, 'serviceable obtainable market')
      .replace(/\bLLM\b/g, 'large language model')
      .replace(/\bSSML\b/g, 'S.S.M.L.')
      .replace(/\bROI\b/g, 'return on investment')
      .replace(/\bUX\b/g, 'user experience')
      .replace(/\bUI\b/g, 'user interface')
      .replace(/\bSEO\b/g, 'search engine optimization')
      .replace(/\bAPI\b/g, 'A.P.I.')

      // ── Per-unit shorthand ──
      .replace(/\/yr\b/g, ' per year')
      .replace(/\/mo\b/g, ' per month')
      .replace(/\/min\b/g, ' per minute')
      .replace(/\/hr\b/g, ' per hour')
      .replace(/\/user\b/g, ' per user')

      // ── Final cleanup ──
      .replace(/\s{2,}/g, ' ')
      .replace(/,\s*,/g, ',')
      .trim();
  }

  // Smart sentence splitter — doesn't break on "Dr.", "U.S.A.", decimal numbers
  function splitSentences(text) {
    // Temporarily protect known non-sentence-end periods
    return text
      .replace(/\b(Dr|Mr|Mrs|Ms|Prof|St|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|No|Fig|vs|approx|ca)\./g, '$1\x01')
      .replace(/(\d)\.\s*(\d)/g, '$1\x01$2')            // decimals like 3.14
      .replace(/([A-Z])\.\s*([A-Z])\./g, '$1\x01$2\x01') // U.S.A.
      .replace(/([.!?])\s+(?=[A-Z"'])/g, '$1\x00')       // real sentence breaks
      .split('\x00')
      .map(s => s.replace(/\x01/g, '.').trim())
      .filter(s => s.length > 4);
  }

  // Rule-based speech annotation — instant, no server
  function ruleBasedAnnotate(sentences, tag) {
    const isHeading = ['H1', 'H2', 'H3', 'H4'].includes(tag);
    const isList = tag === 'LI';
    const isQuote = tag === 'BLOCKQUOTE';
    const total = sentences.length;

    return sentences.map((text, i) => {
      const wordCount = text.split(/\s+/).length;
      const isFirst = i === 0;
      const isLast = i === total - 1;

      // Rate
      let rate;
      if (isHeading) rate = 0.82;   // slow and clear for headings
      else if (wordCount > 35) rate = 0.88;  // long/dense sentence
      else if (wordCount < 7) rate = 1.05;  // short transitional
      else if (isList) rate = 1.0;
      else rate = 0.95;  // comfortable reading pace

      // Pause after this sentence
      let pause_after;
      if (tag === 'H1') pause_after = 1200;
      else if (tag === 'H2') pause_after = 800;
      else if (tag === 'H3') pause_after = 600;
      else if (isLast) pause_after = 380;  // paragraph end
      else pause_after = 110;  // mid-paragraph flow

      // Importance heuristic: first sentence of a paragraph = topic sentence
      const important = isFirst && !isList && !isHeading;

      // Type from HTML structure
      const type = isHeading ? 'heading' :
        isQuote ? 'example' :
          isList ? 'normal' : 'normal';

      return { text, rate, pause_after, important, type };
    });
  }

  // ─────────────────────────────────────────────
  // 4. PARAGRAPH ASSOCIATION
  // Map each annotated sentence to a DOM block element
  // using proportional character-count estimation
  // ─────────────────────────────────────────────
  function assignParagraphElements(blocks, sentences) {
    // Build cumulative char positions for each block
    let totalChars = 0;
    const paraRanges = blocks.map(b => {
      const start = totalChars;
      totalChars += b.text.length + 2; // +2 for \n\n
      return { el: b.el, start, end: totalChars, tag: b.tag };
    });

    // Walk through sentences and assign to closest block
    let sentCharPos = 0;
    sentences.forEach(s => {
      let assigned = paraRanges.find(r => sentCharPos >= r.start && sentCharPos < r.end);
      if (!assigned) assigned = paraRanges[paraRanges.length - 1];
      s.paraEl = assigned ? assigned.el : null;
      s.paraTag = assigned ? assigned.tag : 'P';
      sentCharPos += s.text.length + 1;
    });
  }

  // ─────────────────────────────────────────────
  // 5. PLAYER UI
  // ─────────────────────────────────────────────
  function createPlayer() {
    if (state.playerEl) state.playerEl.remove();

    const div = document.createElement('div');
    div.id = 'tts-player';
    div.setAttribute('aria-label', 'AI TTS Reader Player');
    div.innerHTML = `
      <div class="tts-player-header">
        <div class="tts-player-title">
          <span class="tts-logo-icon">🎧</span>
          <span class="tts-player-name">AI Reader</span>
          <span class="tts-ai-badge">AI</span>
        </div>
        <button class="tts-btn-icon tts-close-btn" id="tts-close" title="Close">✕</button>
      </div>

      <div class="tts-status-bar">
        <span class="tts-status-text" id="tts-status">Extracting article...</span>
        <span class="tts-important-badge" id="tts-important-badge" style="display:none">★ Key point</span>
      </div>

      <div class="tts-sentence-preview" id="tts-preview"></div>

      <div class="tts-progress-track">
        <div class="tts-progress-fill" id="tts-progress"></div>
      </div>

      <div class="tts-controls">
        <button class="tts-btn-icon" id="tts-prev" title="Previous sentence">⏮</button>
        <button class="tts-btn-play" id="tts-play" title="Play / Pause">▶</button>
        <button class="tts-btn-icon" id="tts-next" title="Next sentence">⏭</button>
      </div>

      <div class="tts-speed-row">
        <span class="tts-speed-label">Speed</span>
        <div class="tts-speed-btns">
          <button class="tts-speed-btn" data-speed="0.75">0.75×</button>
          <button class="tts-speed-btn tts-speed-active" data-speed="1.0">1×</button>
          <button class="tts-speed-btn" data-speed="1.25">1.25×</button>
          <button class="tts-speed-btn" data-speed="1.5">1.5×</button>
        </div>
      </div>

      <div class="tts-voice-row">
        <span class="tts-speed-label">Voice</span>
        <select class="tts-voice-select" id="tts-voice-select" title="Switch voice"></select>
        <span class="tts-voice-label" id="tts-voice-label">Loading…</span>
      </div>

      <div class="tts-insights-row" id="tts-insights-row" style="display:none">
        <div class="tts-insights-dot" id="tts-insights-dot"></div>
        <span class="tts-insights-text" id="tts-insights-text">Analyzing page…</span>
      </div>

      <div class="tts-summary-panel" id="tts-summary-panel" style="display:none">
        <div class="tts-summary-header" id="tts-summary-header">
          <span class="tts-summary-title">💡 AI Summary</span>
          <span class="tts-summary-chevron" id="tts-summary-chevron">▼</span>
        </div>
        <div class="tts-summary-body" id="tts-summary-body" style="display:none"></div>
      </div>
    `;

    document.body.appendChild(div);
    state.playerEl = div;

    // Wire up controls
    div.querySelector('#tts-play').addEventListener('click', togglePlayPause);
    div.querySelector('#tts-prev').addEventListener('click', () => navigate(-1));
    div.querySelector('#tts-next').addEventListener('click', () => navigate(1));
    div.querySelector('#tts-close').addEventListener('click', stopAndClose);

    div.querySelectorAll('.tts-speed-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        div.querySelectorAll('.tts-speed-btn').forEach(b => b.classList.remove('tts-speed-active'));
        e.currentTarget.classList.add('tts-speed-active');
        state.speedMultiplier = parseFloat(e.currentTarget.dataset.speed);
        if (state.playing && !state.paused) {
          // Restart current sentence at new speed
          speechSynthesis.cancel();
          setTimeout(() => speakCurrent(), 80);
        }
      });
    });

    // Summary panel toggle
    const summaryHeader = div.querySelector('#tts-summary-header');
    if (summaryHeader) {
      summaryHeader.addEventListener('click', () => {
        const body = div.querySelector('#tts-summary-body');
        const chevron = div.querySelector('#tts-summary-chevron');
        if (!body) return;
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : 'block';
        if (chevron) chevron.classList.toggle('open', !open);
      });
    }

    // Make player draggable
    makeDraggable(div);
  }

  function makeDraggable(el) {
    let ox = 0, oy = 0, dragging = false;
    const header = el.querySelector('.tts-player-header');

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      ox = e.clientX - el.getBoundingClientRect().left;
      oy = e.clientY - el.getBoundingClientRect().top;
      el.style.transition = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = (e.clientX - ox) + 'px';
      el.style.top = (e.clientY - oy) + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      dragging = false;
      el.style.transition = '';
    });
  }

  function setStatus(text) {
    const el = document.getElementById('tts-status');
    if (el) el.textContent = text;
  }

  function updateUI() {
    const playBtn = document.getElementById('tts-play');
    const progress = document.getElementById('tts-progress');
    const preview = document.getElementById('tts-preview');
    const badge = document.getElementById('tts-important-badge');

    if (playBtn) {
      playBtn.textContent = (state.playing && !state.paused) ? '⏸' : '▶';
    }

    if (progress && state.sentences.length > 0) {
      const pct = ((state.index + 1) / state.sentences.length) * 100;
      progress.style.width = `${pct}%`;
    }

    const s = state.sentences[state.index];
    if (s) {
      const pos = `${state.index + 1} / ${state.sentences.length}`;
      setStatus(`${pos}${s.type !== 'normal' ? ` · ${s.type}` : ''}`);

      if (preview) {
        preview.textContent = s.text.length > 90 ? s.text.slice(0, 90) + '…' : s.text;
      }

      if (badge) {
        badge.style.display = s.important ? 'inline' : 'none';
      }
    }
  }

  // ─────────────────────────────────────────────
  // 6. HIGHLIGHTING
  // ─────────────────────────────────────────────
  let lastHighlighted = null;

  function highlight(index) {
    // Remove previous highlight
    if (lastHighlighted) {
      lastHighlighted.classList.remove('tts-highlight', 'tts-highlight-important', 'tts-highlight-heading');
    }

    const s = state.sentences[index];
    if (!s || !s.paraEl) return;

    const el = s.paraEl;
    el.classList.add('tts-highlight');
    if (s.important) el.classList.add('tts-highlight-important');
    if (s.paraTag === 'H1' || s.paraTag === 'H2' || s.paraTag === 'H3') {
      el.classList.add('tts-highlight-heading');
    }

    lastHighlighted = el;

    // Scroll smoothly into view (only if not in viewport)
    const rect = el.getBoundingClientRect();
    const inView = rect.top >= 0 && rect.bottom <= window.innerHeight;
    if (!inView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function clearHighlight() {
    if (lastHighlighted) {
      lastHighlighted.classList.remove('tts-highlight', 'tts-highlight-important', 'tts-highlight-heading');
      lastHighlighted = null;
    }
  }

  // ─────────────────────────────────────────────
  // 6b. WORD-LEVEL HIGHLIGHTING
  // Wraps each word in a <span class="tts-word"> so we can underline
  // the exact word being spoken via the SpeechSynthesis boundary event.
  // ─────────────────────────────────────────────

  function wrapWordsInElement(el) {
    if (!el) return [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      // Skip text inside injected knowledge badges — they're not article content
      acceptNode: (node) =>
        node.parentElement && node.parentElement.closest('.tts-knowledge-badge')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
    });
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      // Skip whitespace-only nodes
      if (node.textContent.trim()) textNodes.push(node);
    }

    const wordSpans = [];
    for (const textNode of textNodes) {
      const parts = textNode.textContent.split(/(\s+)/);
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        if (/\S/.test(part)) {
          const span = document.createElement('span');
          span.className = 'tts-word';
          span.textContent = part;
          wordSpans.push(span);
          frag.appendChild(span);
        } else if (part) {
          frag.appendChild(document.createTextNode(part));
        }
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }
    return wordSpans;
  }

  function restoreWordSpans(el) {
    if (!el) return;
    // Replace each span with its text content, then merge adjacent text nodes
    el.querySelectorAll('.tts-word').forEach(span => {
      span.replaceWith(document.createTextNode(span.textContent));
    });
    el.normalize();
  }

  function clearWordHighlight() {
    if (state.wordState.activeSpan) {
      state.wordState.activeSpan.classList.remove('tts-word-active');
      state.wordState.activeSpan = null;
    }
  }

  function resetWordState() {
    if (state.wordState.timingInterval) {
      clearInterval(state.wordState.timingInterval);
      state.wordState.timingInterval = null;
    }
    restoreWordSpans(state.wordState.wrappedEl);
    state.wordState.wrappedEl = null;
    state.wordState.spans = [];
    state.wordState.paraWordOffset = 0;
    state.wordState.activeSpan = null;
  }

  // ─────────────────────────────────────────────
  // 7. WEB SPEECH API PLAYBACK
  // ─────────────────────────────────────────────
  function loadVoices() {
    return new Promise((resolve) => {
      let voices = speechSynthesis.getVoices();
      if (voices.length > 0) { resolve(voices); return; }
      speechSynthesis.addEventListener('voiceschanged', () => {
        resolve(speechSynthesis.getVoices());
      }, { once: true });
      setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
    });
  }

  // Score a voice by quality tier — higher = better
  function voiceScore(v) {
    if (!v.lang.startsWith('en')) return -1;
    const n = v.name;
    if (n.includes('(Enhanced)')) return 100;
    if (n.includes('(Premium)')) return 90;
    if (n.includes('(Neural)')) return 85;
    if (n.startsWith('Google')) return 70;
    if (n.includes('Samantha') || n.includes('Karen') || n.includes('Daniel') ||
      n.includes('Moira') || n.includes('Tessa') || n.includes('Serena')) return 60;
    if (n.includes('Microsoft') && (n.includes('Jenny') || n.includes('Aria') ||
      n.includes('Guy') || n.includes('Zira'))) return 55;
    if (v.lang === 'en-US') return 30;
    if (v.lang.startsWith('en')) return 20;
    return 10;
  }

  function getEnglishVoices(voices) {
    return voices
      .filter(v => v.lang.startsWith('en'))
      .sort((a, b) => voiceScore(b) - voiceScore(a));
  }

  function selectBestVoice(voices) {
    const ranked = getEnglishVoices(voices);
    return ranked[0] || voices[0] || null;
  }

  // Show voice name cleanly (strip lang suffix, shorten)
  function shortVoiceName(voice) {
    if (!voice) return 'Default';
    return voice.name
      .replace(' (Enhanced)', ' ✦')
      .replace(' (Premium)', ' ✦')
      .replace(' (Neural)', ' ✦')
      .replace('Google ', '')
      .replace('Microsoft ', '')
      .replace(/ - [A-Z]{2}$/, '');
  }

  // Warm up the speech engine (eliminates the robotic "click" on first word)
  function warmUpSpeech(voice) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      u.rate = 1;
      if (voice) u.voice = voice;
      u.onend = resolve;
      u.onerror = resolve;
      speechSynthesis.speak(u);
      setTimeout(resolve, 600);
    });
  }

  // Populate voice picker dropdown with ranked English voices
  function populateVoicePicker(voices) {
    const select = document.getElementById('tts-voice-select');
    if (!select) return;
    const ranked = getEnglishVoices(voices);
    ranked.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = shortVoiceName(v);
      opt.dataset.name = v.name;
      if (v === state.preferredVoice) opt.selected = true;
      select.appendChild(opt);
    });
    state.rankedVoices = ranked;

    select.addEventListener('change', (e) => {
      const idx = parseInt(e.target.value);
      state.preferredVoice = state.rankedVoices[idx] || null;
      updateVoiceLabel();
      // If playing, restart current sentence with new voice
      if (state.playing && !state.paused) {
        speechSynthesis.cancel();
        setTimeout(() => speakCurrent(), 100);
      }
    });
  }

  function updateVoiceLabel() {
    const label = document.getElementById('tts-voice-label');
    if (label && state.preferredVoice) {
      label.textContent = shortVoiceName(state.preferredVoice);
      const isEnhanced = state.preferredVoice.name.includes('Enhanced') ||
        state.preferredVoice.name.includes('Premium') ||
        state.preferredVoice.name.includes('Neural');
      label.className = 'tts-voice-label' + (isEnhanced ? ' tts-voice-enhanced' : ' tts-voice-basic');
    }
  }

  function speakCurrent() {
    const s = state.sentences[state.index];
    if (!s) return;

    highlight(state.index);
    updateUI();

    // ── Word wrapping ──
    // When we enter a new paragraph element, wrap its words into spans.
    // When we leave (next sentence is in a different para), restore the old one.
    if (s.paraEl && s.paraEl !== state.wordState.wrappedEl) {
      restoreWordSpans(state.wordState.wrappedEl);
      state.wordState.spans = wrapWordsInElement(s.paraEl);
      state.wordState.wrappedEl = s.paraEl;
      state.wordState.paraWordOffset = 0;
      state.wordState.activeSpan = null;
    }

    // Remember word start position for this sentence within the paragraph
    const sentenceWordStart = state.wordState.paraWordOffset;

    // DOM word array (original text) for span indexing
    // Normalized text may have more words than DOM (e.g. "150" → "one hundred fifty")
    // so we always use domText word counts when indexing into DOM spans.
    const domWordArr = (s.domText || s.text).split(/\s+/).filter(Boolean);
    const normWordArr = s.text.split(/\s+/).filter(Boolean);

    // ── Build utterance ──
    const baseRate = s.rate * state.speedMultiplier * 0.95;
    const utterance = new SpeechSynthesisUtterance(s.text);
    utterance.rate = Math.max(0.5, Math.min(1.8, baseRate));
    utterance.pitch = s.type === 'heading' ? 1.08 :
      s.type === 'conclusion' ? 0.96 :
        s.type === 'thesis' ? 0.98 : 1.0;
    utterance.volume = 1.0;
    if (state.preferredVoice) utterance.voice = state.preferredVoice;

    // ── Word highlighting — timing + optional onboundary precision ──
    //
    // Strategy: start a timing-based interval immediately when speech begins.
    // The interval advances one DOM word-span per estimated tick (~WPM).
    // If the voice also emits onboundary word events, switch to those on the
    // first event for precise sync and stop the timer.
    // This guarantees visible highlighting regardless of voice support.
    const wpm = 140 * utterance.rate;
    const msPerWord = Math.max(60, 60000 / wpm);
    let timingIdx = 0;    // which DOM span the timer is currently on
    let usingBoundary = false; // true once we've seen the first word boundary event

    function startTimingInterval() {
      if (state.wordState.timingInterval) return; // already running
      const timer = setInterval(() => {
        if (usingBoundary || !state.playing) { clearInterval(timer); return; }
        clearWordHighlight();
        const span = state.wordState.spans[sentenceWordStart + timingIdx];
        if (span) {
          span.classList.add('tts-word-active');
          state.wordState.activeSpan = span;
        }
        timingIdx++;
        if (timingIdx >= domWordArr.length) { clearInterval(timer); state.wordState.timingInterval = null; }
      }, msPerWord);
      state.wordState.timingInterval = timer;
    }

    // Start timing as soon as speech begins (onstart is reliable in Chrome).
    utterance.onstart = startTimingInterval;

    // ── Word boundary → precise underline (when the voice supports it) ──
    utterance.onboundary = (e) => {
      if (e.name !== 'word') return;

      if (!usingBoundary) {
        // First boundary event: kill the timer and take over with precision
        usingBoundary = true;
        if (state.wordState.timingInterval) {
          clearInterval(state.wordState.timingInterval);
          state.wordState.timingInterval = null;
        }
      }

      clearWordHighlight();

      // charIndex is the byte offset of the word in utterance.text (normalized).
      // Count spaces before it to get the 0-based word index in normalized text.
      const textBefore = s.text.slice(0, e.charIndex);
      const normWordIdx = textBefore.split(/\s+/).filter(Boolean).length;

      // Map normalized index → DOM span index proportionally.
      // Needed because normalization expands numbers/abbreviations
      // ("150" → "one hundred fifty" = 3 norm words vs 1 DOM word).
      const mappedDomIdx = normWordArr.length > 0
        ? Math.min(
          Math.round((normWordIdx / normWordArr.length) * domWordArr.length),
          domWordArr.length - 1
        )
        : normWordIdx;

      const span = state.wordState.spans[sentenceWordStart + mappedDomIdx];
      if (span) {
        span.classList.add('tts-word-active');
        state.wordState.activeSpan = span;
      }
    };

    // ── End of sentence ──
    utterance.onend = () => {
      if (state.wordState.timingInterval) {
        clearInterval(state.wordState.timingInterval);
        state.wordState.timingInterval = null;
      }
      clearWordHighlight();

      // Advance by DOM word count (not normalized), so the next sentence in
      // the same paragraph starts at the correct span index.
      state.wordState.paraWordOffset += domWordArr.length;

      if (!state.playing) return;

      const pause = s.pause_after || 150;
      setTimeout(() => {
        if (!state.playing) return;
        state.index++;

        if (state.index < state.sentences.length) {
          speakCurrent();
        } else {
          // Finished entire article
          state.playing = false;
          resetWordState();
          clearHighlight();
          setStatus('Finished ✓');
          const playBtn = document.getElementById('tts-play');
          if (playBtn) playBtn.textContent = '▶';
          saveBookmark(0);
        }
      }, pause);
    };

    utterance.onerror = (e) => {
      if (e.error === 'interrupted') return;
      console.warn('[TTS] Speech error:', e.error);
    };

    speechSynthesis.speak(utterance);
  }

  function togglePlayPause() {
    if (!state.sentences.length) return;

    if (!state.playing) {
      // Start or resume from pause
      state.playing = true;
      state.paused = false;

      if (speechSynthesis.paused) {
        speechSynthesis.resume();
        updateUI();
      } else {
        if (state.index < 0) state.index = 0;
        speakCurrent();
      }
    } else if (state.paused) {
      // Resume
      state.paused = false;
      state.playing = true;
      speechSynthesis.resume();
      updateUI();
    } else {
      // Pause
      state.paused = true;
      speechSynthesis.pause();
      saveBookmark(state.index);
      updateUI();
    }
  }

  function navigate(dir) {
    speechSynthesis.cancel();
    clearWordHighlight();

    // Stop any running timing fallback
    if (state.wordState.timingInterval) {
      clearInterval(state.wordState.timingInterval);
      state.wordState.timingInterval = null;
    }

    // Fully reset word wrapping so speakCurrent() re-wraps from scratch
    restoreWordSpans(state.wordState.wrappedEl);
    state.wordState.wrappedEl = null;
    state.wordState.spans = [];
    state.wordState.activeSpan = null;

    state.index = Math.max(0, Math.min(state.sentences.length - 1, state.index + dir));

    // Recompute paraWordOffset for the new sentence's position inside its paragraph.
    // Sum DOM word counts of all preceding sentences that share the same paraEl.
    const targetS = state.sentences[state.index];
    if (targetS && targetS.paraEl) {
      let offset = 0;
      for (let i = 0; i < state.index; i++) {
        const prev = state.sentences[i];
        if (prev.paraEl === targetS.paraEl) {
          offset += (prev.domText || prev.text).split(/\s+/).filter(Boolean).length;
        }
      }
      state.wordState.paraWordOffset = offset;
    } else {
      state.wordState.paraWordOffset = 0;
    }

    if (state.playing && !state.paused) {
      setTimeout(() => speakCurrent(), 80);
    } else {
      highlight(state.index);
      updateUI();
    }
  }

  function stopAndClose() {
    state.playing = false;
    state.paused = false;
    speechSynthesis.cancel();
    if (state.wordState.timingInterval) {
      clearInterval(state.wordState.timingInterval);
      state.wordState.timingInterval = null;
    }
    saveBookmark(state.index);
    _session++;                    // invalidate any running background tasks
    state.sentences = [];
    state.index = -1;
    resetWordState();
    clearHighlight();
    clearKnowledgeHighlights();
    hideHoverTooltip();
    if (state.playerEl) {
      state.playerEl.remove();
      state.playerEl = null;
    }
    window.__ttsReaderActive = false;
  }

  // ─────────────────────────────────────────────
  // 8. BOOKMARKS
  // ─────────────────────────────────────────────
  function saveBookmark(index) {
    const key = `bm_${location.href}`;
    chrome.storage.local.set({ [key]: index });
  }

  function loadBookmark() {
    return new Promise((resolve) => {
      const key = `bm_${location.href}`;
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] != null ? result[key] : 0);
      });
    });
  }

  // ─────────────────────────────────────────────
  // 9. MAIN ORCHESTRATION
  // Phase 1: instant rule-based start (~400ms)
  // Phase 2: AI silently upgrades upcoming sentences
  // ─────────────────────────────────────────────
  async function main() {
    const mySession = ++_session; // capture before any await
    createPlayer();
    setStatus('Reading page...');

    // Kick off voice loading + warmup in parallel — don't await yet
    const voicePromise = loadVoices().then(async (voices) => {
      state.voices = voices;
      state.preferredVoice = selectBestVoice(voices);
      populateVoicePicker(voices);
      updateVoiceLabel();
      await warmUpSpeech(state.preferredVoice);
    });

    // Extract DOM blocks
    const blocks = extractArticle();
    if (!blocks.length) {
      setStatus('⚠ No article content found on this page.');
      return;
    }

    // ── PHASE 1: instant rule-based annotation ──
    // Split from ORIGINAL text first so domText matches DOM word spans,
    // then normalize each sentence individually for clean speech output.
    const allSentences = [];
    for (const block of blocks) {
      const domSents = splitSentences(block.text);              // original
      const normSents = domSents.map(t => normalizeForSpeech(t)); // spoken
      const annotated = ruleBasedAnnotate(normSents, block.tag);
      annotated.forEach((s, i) => {
        s.paraEl = block.el;
        s.paraTag = block.tag;
        s.domText = domSents[i] || s.text; // original DOM text for span counting
      });
      allSentences.push(...annotated);
    }

    if (!allSentences.length) {
      setStatus('⚠ Could not extract sentences.');
      return;
    }

    state.sentences = allSentences;

    // Wait just for voices (warmup, not AI)
    await voicePromise;

    const savedIndex = await loadBookmark();
    const naturalStart = findNaturalStartIndex(allSentences);

    // Use saved bookmark only if it's meaningfully past the natural start
    // (prevents re-starting in a nav element due to a stale bookmark)
    state.index = (savedIndex > naturalStart && savedIndex < allSentences.length)
      ? savedIndex
      : naturalStart;

    const resumeLabel = state.index > naturalStart ? ` · resuming at ${state.index + 1}` : '';
    setStatus(`${allSentences.length} sentences${resumeLabel}`);
    highlight(state.index);
    updateUI();

    // Activate hover-to-read now that the reader is live
    initHoverReading();

    // Start speaking immediately
    state.playing = true;
    setTimeout(() => speakCurrent(), 350);

    // Abort if the user already navigated away while we were awaiting voices/bookmark
    if (mySession !== _session) return;

    // ── PHASE 2: AI upgrade + knowledge extraction in background ──
    upgradeWithAI(blocks, allSentences, mySession);
    runKnowledgeExtraction(blocks, mySession);
  }

  // ─────────────────────────────────────────────
  // HOVER-TO-READ SYSTEM
  // When the player is open, hovering over content elements
  // shows a floating "▶ Read from here" tooltip pill.
  // Clicking it immediately jumps reading to that block.
  // ─────────────────────────────────────────────

  const HOVER_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'LI', 'BLOCKQUOTE', 'TD', 'TH']);

  function initHoverReading() {
    if (state.hoverListenersAdded) return;
    state.hoverListenersAdded = true;

    document.body.addEventListener('mouseover', onContentMouseOver, { passive: true });
    document.body.addEventListener('mouseleave', onContentMouseLeave, { passive: true });
  }

  function onContentMouseOver(e) {
    // Only active while player is showing
    if (!state.playerEl) return;

    // Walk up to find a relevant block element
    let target = e.target;
    while (target && target !== document.body) {
      if (HOVER_TAGS.has(target.tagName)) break;
      target = target.parentElement;
    }
    if (!target || target === document.body) return;
    // Don't hover-highlight the player itself or the tooltip
    if (target.closest('#tts-player') || target.closest('.tts-hover-tooltip')) return;
    // Only hover elements that are actually in our extracted sentences
    const matchedSentence = state.sentences.find(s => s.paraEl === target);
    if (!matchedSentence) return;

    if (target === state.hoverEl) return; // same element, nothing to do
    hideHoverTooltip();
    state.hoverEl = target;
    target.classList.add('tts-hover-highlight');
    showHoverTooltip(target, matchedSentence);
  }

  function onContentMouseLeave(e) {
    // Hide when the mouse leaves the document body entirely
    if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
      hideHoverTooltip();
    }
  }

  function showHoverTooltip(el, sentence) {
    // Remove any existing tooltip first
    if (state.hoverTooltipEl) state.hoverTooltipEl.remove();

    const tooltip = document.createElement('div');
    tooltip.className = 'tts-hover-tooltip';

    const label = document.createElement('span');
    label.className = 'tts-tooltip-label';
    label.textContent = sentence.paraTag === 'H1' || sentence.paraTag === 'H2' ? '📖 Section' : '¶ Paragraph';

    const btn = document.createElement('button');
    btn.className = 'tts-tooltip-btn';
    btn.textContent = '▶ Read from here';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      jumpToElement(el);
      hideHoverTooltip();
    });

    // Prevent the tooltip itself from triggering mouseleave on the element
    tooltip.addEventListener('mouseover', (e) => e.stopPropagation());

    tooltip.appendChild(label);
    tooltip.appendChild(btn);
    document.body.appendChild(tooltip);
    state.hoverTooltipEl = tooltip;

    // Position tooltip above the element, clamped to viewport
    positionTooltip(tooltip, el);
  }

  function positionTooltip(tooltip, el) {
    const rect = el.getBoundingClientRect();
    const tw = tooltip.offsetWidth || 180;
    const th = tooltip.offsetHeight || 34;
    const GAP = 6; // px gap between element top and tooltip bottom

    let top = rect.top - th - GAP;
    let left = rect.left + (rect.width / 2) - (tw / 2);

    // Clamp within viewport
    top = Math.max(6, Math.min(top, window.innerHeight - th - 6));
    left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));

    tooltip.style.top = top + 'px';
    tooltip.style.left = left + 'px';
  }

  function hideHoverTooltip() {
    if (state.hoverTooltipEl) {
      state.hoverTooltipEl.remove();
      state.hoverTooltipEl = null;
    }
    if (state.hoverEl) {
      state.hoverEl.classList.remove('tts-hover-highlight');
      state.hoverEl = null;
    }
  }

  // Jump reading to the first sentence of the given DOM element.
  function jumpToElement(el) {
    // Find the first sentence whose paraEl matches this element
    const targetIdx = state.sentences.findIndex(s => s.paraEl === el);
    if (targetIdx < 0) return;

    // Cancel current speech and word state
    speechSynthesis.cancel();
    clearWordHighlight();
    if (state.wordState.timingInterval) {
      clearInterval(state.wordState.timingInterval);
      state.wordState.timingInterval = null;
    }
    restoreWordSpans(state.wordState.wrappedEl);
    state.wordState.wrappedEl = null;
    state.wordState.spans = [];
    state.wordState.activeSpan = null;
    state.wordState.paraWordOffset = 0;

    state.index = targetIdx;
    state.playing = true;
    state.paused = false;

    highlight(state.index);
    updateUI();
    setTimeout(() => speakCurrent(), 80);
  }

  // ─────────────────────────────────────────────
  // 10. BACKGROUND AI UPGRADER
  // Runs after instant playback has started.
  // Patches state.sentences[i] for i > current index.
  // ─────────────────────────────────────────────
  async function upgradeWithAI(blocks, sentences, mySession) {
    // Build a flat map: sentence index → block for correct para assignment
    // Use original text for splitting (consistent with main())
    const sentBlockMap = [];
    for (const block of blocks) {
      const sents = splitSentences(block.text);
      sents.forEach(() => sentBlockMap.push(block));
    }

    const chunks = chunkBlocks(blocks, 2500);
    let sentOffset = 0; // tracks which sentence index each chunk starts at

    for (const chunk of chunks) {
      // Count sentences in this chunk — use original text (same as main())
      let chunkSentCount = 0;
      for (let bi = chunk.startIdx; bi <= chunk.endIdx; bi++) {
        const b = blocks[bi];
        if (b) chunkSentCount += splitSentences(b.text).length;
      }

      const chunkStart = sentOffset;
      const chunkEnd = sentOffset + chunkSentCount;
      sentOffset = chunkEnd;

      // Bail out if a newer session (new page / close) has started
      if (mySession !== _session) return;

      // Skip chunks we've already spoken past
      if (chunkEnd <= state.index) continue;

      try {
        const aiSentences = await annotatechunk(chunk.text);

        // Check again after the await — navigation could have happened during the fetch
        if (mySession !== _session) return;

        // Merge AI results into upcoming slots
        let aiIdx = 0;
        for (let si = chunkStart; si < chunkEnd && aiIdx < aiSentences.length; si++, aiIdx++) {
          if (si <= state.index) continue; // never touch already-spoken
          if (si >= sentences.length) break;

          const ai = aiSentences[aiIdx];
          if (!ai || !ai.text) continue;

          // Preserve DOM references — only update speech parameters
          sentences[si].text = ai.text;
          sentences[si].rate = ai.rate ?? sentences[si].rate;
          sentences[si].pause_after = ai.pause_after ?? sentences[si].pause_after;
          sentences[si].important = ai.important ?? sentences[si].important;
          sentences[si].type = ai.type ?? sentences[si].type;
        }
      } catch {
        // Silent failure — rule-based version stays in place
      }
    }
  }

  // ─────────────────────────────────────────────
  // 11. KNOWLEDGE EXTRACTION
  // Calls Claude to identify the most important paragraphs/elements,
  // applies coloured left-border highlights + inline category badges,
  // and shows an AI summary in the player card.
  // ─────────────────────────────────────────────

  // Normalise text for fuzzy matching (lowercase, collapsed whitespace)
  function normForMatch(text) {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Find the best DOM block for a given AI-returned match string.
  // Tries progressively shorter prefixes to be robust against minor differences.
  function findBlockForMatch(matchText, blocks) {
    const norm = normForMatch(matchText);
    for (const len of [50, 35, 20]) {
      const prefix = norm.slice(0, len);
      if (prefix.length < 12) break;
      for (const block of blocks) {
        if (normForMatch(block.text).includes(prefix)) return block;
      }
    }
    return null;
  }

  // Apply visual highlights + badges to matched blocks
  function applyKnowledgeHighlights(keyElements, blocks) {
    const used = new Set(); // prevent double-highlighting the same element

    for (const ke of keyElements) {
      if (!ke.match || !ke.importance) continue;
      const block = findBlockForMatch(ke.match, blocks);
      if (!block || used.has(block.el)) continue;
      used.add(block.el);

      const el = block.el;
      const cssClass = `tts-knowledge-${ke.importance}`;
      el.classList.add(cssClass);

      // Prepend an inline badge for critical + high elements
      if (ke.importance !== 'medium') {
        const badge = document.createElement('span');
        badge.className = 'tts-knowledge-badge';
        badge.textContent = ke.label || ke.category || ke.importance;
        el.insertBefore(badge, el.firstChild);
        state.knowledgeHighlights.push({ el, cssClass, badge });
      } else {
        state.knowledgeHighlights.push({ el, cssClass, badge: null });
      }
    }
  }

  // Remove all knowledge highlights from the DOM
  function clearKnowledgeHighlights() {
    for (const { el, cssClass, badge } of state.knowledgeHighlights) {
      el.classList.remove(cssClass);
      if (badge && badge.parentNode === el) el.removeChild(badge);
    }
    state.knowledgeHighlights = [];
  }

  // Send text to service worker → backend → Claude
  function callExtractKnowledge(text) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'EXTRACT_KNOWLEDGE', text }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.success) {
          reject(new Error(response?.error || 'Knowledge extraction failed'));
          return;
        }
        resolve(response);
      });
    });
  }

  // Orchestrate knowledge extraction: call AI, apply highlights, show summary
  async function runKnowledgeExtraction(blocks, mySession) {
    // Show the insights row with a pulsing dot
    const row = document.getElementById('tts-insights-row');
    const dot = document.getElementById('tts-insights-dot');
    const text = document.getElementById('tts-insights-text');
    if (row) row.style.display = 'flex';

    // Build full article text (up to 6 000 chars)
    const fullText = blocks.map(b => b.text).join('\n\n').slice(0, 6000);

    try {
      const result = await callExtractKnowledge(fullText);

      // If the user navigated away or closed while we were fetching, discard results
      if (mySession !== _session) return;
      const { key_elements, summary } = result;

      if (!key_elements || !key_elements.length) {
        if (text) text.textContent = 'No key insights found';
        if (dot) { dot.classList.add('done'); }
        return;
      }

      applyKnowledgeHighlights(key_elements, blocks);

      // Update insights counter
      const critCount = key_elements.filter(e => e.importance === 'critical').length;
      const highCount = key_elements.filter(e => e.importance === 'high').length;
      if (text) {
        text.innerHTML = `<strong>${key_elements.length} insights</strong> · ${critCount} critical · ${highCount} key`;
      }
      if (dot) dot.classList.add('done');

      // Show summary panel
      if (summary) {
        const panel = document.getElementById('tts-summary-panel');
        const body = document.getElementById('tts-summary-body');
        if (panel) panel.style.display = 'block';
        if (body) body.textContent = summary;
      }

    } catch (err) {
      console.warn('[TTS] Knowledge extraction failed:', err.message);
      if (text) text.textContent = 'AI insights unavailable';
      if (dot) { dot.style.background = '#6b7280'; dot.style.animation = 'none'; }
    }
  }

})();
