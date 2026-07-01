// prompt-card.js - pure helpers behind the iPhone UI's two star features:
//
//   1. splitFencedSegments: carve verbatim reply text into plain/code segments for
//      rendering. LOSSLESS by contract - concatenating the segment texts (fence
//      markers included) reproduces the input byte-for-byte, so the rendered
//      transcript IS the exact session text; code segments merely get a
//      horizontally-scrollable monospace container. Asserted by `npm run validate`.
//
//   2. extractPrompt: when first mate ends a turn on a question / decision /
//      numbered options, derive the sticky answer card - the verbatim question
//      plus large tappable buttons whose taps submit the answer text (equivalent
//      to speaking it).
//
// DOM-free and environment-agnostic (browser + node) like the rest of src/web.

/**
 * Split text into [{kind:'plain'|'code', text}] where code segments are whole
 * ``` fenced blocks INCLUDING their fence lines. Σ segment.text === input.
 */
export function splitFencedSegments(text) {
  const s = String(text == null ? '' : text);
  const segments = [];
  // A fenced block: a ``` fence line ... to the closing fence (or EOF while the
  // stream is still growing - an unterminated fence renders as code, not plain).
  const re = /(^|\n)(```[^\n]*\n[\s\S]*?(?:\n```(?=\n|$)|$))/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const codeStart = m.index + m[1].length;
    if (codeStart > last) segments.push({ kind: 'plain', text: s.slice(last, codeStart) });
    segments.push({ kind: 'code', text: m[2] });
    last = re.lastIndex;
  }
  if (last < s.length) segments.push({ kind: 'plain', text: s.slice(last) });
  if (segments.length === 0 && s.length === 0) return [];
  return segments;
}

// Yes/no-shaped questions get explicit Yes/No buttons.
const YESNO_RE = /\b(should i|shall i|want me to|do you want|would you like|can i|may i|ok to|okay to|proceed|confirm)\b/i;

// A numbered option line: "1. text", "2) text" (also "  1. …" list indents).
const OPTION_RE = /^\s{0,3}(\d{1,2})[.)]\s+(.*\S)\s*$/;

function truncateLabel(s, max) {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Derive the sticky interactive-answer card from the final verbatim reply text.
 * Returns null when the turn doesn't ask anything. Otherwise:
 *   { question: string,            // the verbatim paragraph(s) that ask it
 *     options: [{label, send}] }   // tappable answers; `send` is submitted as text
 */
export function extractPrompt(verbatimText) {
  const text = String(verbatimText == null ? '' : verbatimText).trim();
  if (!text || text.indexOf('?') === -1) return null;

  // Work on the tail of the reply: the asking usually closes the turn. Take the
  // last paragraph containing a '?' plus everything after it.
  const paragraphs = text.split(/\n[ \t]*\n/);
  let qIndex = -1;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    if (paragraphs[i].indexOf('?') !== -1) { qIndex = i; break; }
  }
  if (qIndex === -1) return null;
  const question = paragraphs.slice(qIndex).join('\n\n').trim();

  // Numbered options anywhere in the reply become buttons that answer with the
  // option number - how the captain would answer a Claude option list by voice.
  const options = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    const m = OPTION_RE.exec(line);
    if (!m) continue;
    const n = m[1];
    if (seen.has(n)) continue;
    seen.add(n);
    options.push({ label: n + '. ' + truncateLabel(m[2], 46), send: n });
  }
  if (options.length < 2) options.length = 0; // one stray "1." is a list, not a menu

  if (options.length === 0 && YESNO_RE.test(question)) {
    options.push({ label: 'Yes', send: 'yes' }, { label: 'No', send: 'no' });
  }
  return { question, options: options.slice(0, 6) };
}
