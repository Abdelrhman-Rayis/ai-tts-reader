require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ─────────────────────────────────────────────
// Annotation prompt — the core of the product
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a world-class audiobook narrator preparing text for the Web Speech API.
Your goal: make the narration sound like a warm, intelligent human voice — not a robot reading a transcript.

CRITICAL TEXT REWRITING RULES (apply all of these):
1. Numbers & symbols — always spell them out for speech:
   - "150" → "one hundred fifty" | "3.7B" → "three point seven billion" | "12%" → "twelve percent"
   - "$5/month" → "five dollars per month" | "#1" → "number one" | "2025" → "twenty twenty-five"
   - "&" → "and" | "@" → "at" | "+" → "plus" | "~" → "approximately" | "≈" → "roughly"
2. Abbreviations — always expand them:
   - "e.g." → "for example" | "i.e." → "that is" | "etc." → "and so on" | "vs." → "versus"
   - "approx." → "approximately" | "Prof." → "Professor" | "Dr." → "Doctor"
   - "ADHD" → leave as-is (pronounced as a word) | "TTS" → "text to speech" | "AI" → leave as-is
   - "MVP" → "minimum viable product" | "GTM" → "go to market" | "CAGR" → "compound annual growth rate"
3. Remove silently: citation markers [1], (Smith 2024), (p. 42), footnote numbers, URLs
4. Punctuation for natural breathing rhythm:
   - Long sentences (25+ words): add a comma at the natural breath point
   - After an introductory clause, ensure a comma: "In 2025, researchers found..."
   - Replace em-dash " — " with ", " for smooth flow
   - Replace " / " with " or " unless it's a ratio
5. Natural speech patterns:
   - "There are" is more natural than "There exist"
   - Start new thoughts with "And" or "But" if the original uses conjunctions that way
   - Contractions sound warmer: "it is" → "it's" for conversational sentences (not definitions)
   - Numbers at sentence start: "150 researchers" → "One hundred fifty researchers"

SPEECH PARAMETER RULES:
- "rate": how fast to speak this sentence
    * 0.78 → a crucial definition, key thesis, or pivotal finding (slow down so it lands)
    * 0.88 → complex clause, dense data, or multi-part argument
    * 0.95 → normal body text (this is the comfortable listening pace)
    * 1.05 → list items, transitional phrases, parenthetical asides
- "pause_after": silence in milliseconds after this sentence
    * 100 → mid-paragraph, flowing narration
    * 380 → end of paragraph (breathing room)
    * 750 → after a section heading (let it sink in)
    * 1300 → major topic shift or chapter break
- "important": true ONLY for: thesis statements, central definitions, pivotal data, or topic sentences
- "type": one of "heading" | "definition" | "thesis" | "evidence" | "example" | "transition" | "conclusion" | "normal"

Return ONLY a valid JSON array. No markdown. No wrapper. No explanation.
Format: [{"text":"...","rate":0.95,"pause_after":100,"important":false,"type":"normal"}]`;

// ─────────────────────────────────────────────
// Knowledge extraction prompt
// ─────────────────────────────────────────────
const KNOWLEDGE_PROMPT = `You are an expert academic reading assistant for students with ADHD who need to quickly grasp what matters most in a text.

Analyze the provided text and identify 6-12 KEY elements worth visual highlighting. Return ONLY valid JSON — no markdown, no wrapping:

{
  "key_elements": [
    {
      "match": "first 55 chars of the sentence verbatim from the input — must appear exactly",
      "importance": "critical",
      "category": "thesis",
      "label": "Main Point"
    }
  ],
  "summary": "Two plain-English sentences summarizing the absolute core message."
}

IMPORTANCE LEVELS:
- "critical": the central thesis, main finding, or single most essential claim (1-2 max)
- "high": key statistics, pivotal evidence, crucial definitions, strong claims (3-5)
- "medium": supporting examples, secondary evidence, useful context (2-5)

CATEGORIES: thesis | statistic | definition | evidence | conclusion | example | claim | insight

RULES:
- "match" MUST be verbatim text (first 55 chars of the sentence/heading). Never paraphrase.
- "label" is 1-3 words shown as a small badge (e.g. "Main Thesis", "Key Stat", "Definition").
- Always include at least 1 "critical" element.
- Prioritize ADHD-relevant highlights: concrete numbers, clear definitions, action items.
- The summary must be plain, jargon-free, and conversational.`;

// ─────────────────────────────────────────────
// POST /api/extract-knowledge
// ─────────────────────────────────────────────
app.post('/api/extract-knowledge', async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length < 30) {
    return res.status(400).json({ error: 'text field required (min 30 chars)' });
  }

  const truncated = text.slice(0, 6000); // analyse first 6k chars

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: KNOWLEDGE_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Identify the key elements:\n\n${truncated}`
        }
      ]
    });

    const raw = message.content[0].text.trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) result = JSON.parse(m[0]);
      else throw new Error('Could not parse knowledge JSON');
    }

    if (!Array.isArray(result.key_elements)) {
      throw new Error('key_elements must be an array');
    }

    // Sanitise
    result.key_elements = result.key_elements
      .filter(e => e.match && e.importance && e.label)
      .map(e => ({
        match: String(e.match).trim(),
        importance: ['critical', 'high', 'medium'].includes(e.importance) ? e.importance : 'medium',
        category: String(e.category || 'insight').trim(),
        label: String(e.label).trim().slice(0, 20)
      }));

    console.log(`[knowledge] ${result.key_elements.length} elements | ${message.usage.input_tokens}→${message.usage.output_tokens} tokens`);

    res.json({
      success: true,
      key_elements: result.key_elements,
      summary: String(result.summary || '').trim(),
      tokens: message.usage
    });

  } catch (err) {
    console.error('[knowledge] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/annotate
// ─────────────────────────────────────────────
app.post('/api/annotate', async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    return res.status(400).json({ error: 'text field required (min 10 chars)' });
  }

  const truncated = text.slice(0, 3500); // Safety limit per call

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Annotate this text for narration:\n\n${truncated}`
        }
      ]
    });

    const raw = message.content[0].text.trim();

    // Strip markdown code fences if Claude wraps the output
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let sentences;
    try {
      sentences = JSON.parse(cleaned);
    } catch (parseErr) {
      // Attempt to extract JSON array from response
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) {
        sentences = JSON.parse(match[0]);
      } else {
        throw new Error(`JSON parse failed: ${parseErr.message}`);
      }
    }

    if (!Array.isArray(sentences)) {
      throw new Error('Response is not a JSON array');
    }

    // Sanitize each sentence object
    sentences = sentences.map(s => ({
      text: String(s.text || '').trim(),
      rate: Math.min(1.5, Math.max(0.6, Number(s.rate) || 1.0)),
      pause_after: Math.min(2000, Math.max(0, Number(s.pause_after) || 150)),
      important: Boolean(s.important),
      type: String(s.type || 'normal')
    })).filter(s => s.text.length > 0);

    console.log(`[annotate] ${sentences.length} sentences | ${message.usage.input_tokens}→${message.usage.output_tokens} tokens`);

    res.json({
      sentences,
      count: sentences.length,
      tokens: message.usage
    });

  } catch (err) {
    console.error('[annotate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '0.1.0', model: 'claude-haiku-4-5-20251001' });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🎧 AI TTS Reader server running on http://localhost:${PORT}`);
    console.log(`   Model: claude-haiku-4-5-20251001`);
    console.log(`   Health: http://localhost:${PORT}/api/health\n`);
  });
}
module.exports = app;
