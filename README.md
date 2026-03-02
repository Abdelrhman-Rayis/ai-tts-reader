# AI TTS Reader

A Chrome Extension that reads web articles aloud using AI — built to make long academic papers feel less overwhelming.

---

## Why I built this

I'm a PhD student. Reading long papers for hours is exhausting, and my focus drifts. I built this extension so I can *listen* to articles during study sessions — the AI rewrites each sentence into natural spoken language, slows down at key definitions, and highlights exactly what matters most on the page. It turns a wall of text into something closer to having a knowledgeable friend read it to you.

If you struggle with focus during long reading sessions, you're welcome to try it. **Use it at your own responsibility** — this is a personal tool shared as-is, with no warranty or support.

---

## What it does

- **AI narration** — Claude Haiku rewrites each sentence for natural speech (expands abbreviations, adds breathing pauses, slows down at thesis statements)
- **Word-level highlight** — underlines each word as it is spoken
- **Knowledge extraction** — scans the page and highlights key paragraphs by importance tier (critical / high / medium) with color-coded borders
- **AI summary** — a plain-English two-sentence summary of the article's core message
- **Floating player** — play / pause, skip, speed control (0.75× – 1.5×), progress bar

---

## How to use it

### 1. Start the backend server

```bash
cd server
npm install
cp .env.example .env        # add your Anthropic API key
node server.js
```

### 2. Load the extension in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder

### 3. Read an article

Navigate to any article or paper, click the extension icon, and press play.

---

## Requirements

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/) (Claude Haiku — very cheap per session)
- Chrome or a Chromium-based browser

---

## Tech stack

| Layer | Technology |
|---|---|
| AI | Claude Haiku (`claude-haiku-4-5-20251001`) via Anthropic SDK |
| TTS engine | Web Speech API (built into Chrome) |
| Backend | Express.js |
| Extension | Chrome MV3, vanilla JS |

---

## Disclaimer

This is a personal side project built for my own PhD study sessions. It is not a polished product. Use it at your own responsibility.
