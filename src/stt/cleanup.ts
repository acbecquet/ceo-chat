// cleanup.ts — Wispr-Flow-style dictation cleanup: a RAW speech-to-text transcript
// becomes a cleaned, well-formed prompt via ONE fast LLM call, with a HARD fallback
// to the raw transcript so a failed/slow cleanup can NEVER block the call.
//
// This is the "structuring" half of the dictation upgrade (plan `ceochat-stt-w4`,
// report §4). The transcription engine (whisper.cpp, see stt.ts) still produces a
// deterministic offline transcript; this pass fixes obvious ASR misreads ("pole
// request" -> "pull request"), punctuates, and reshapes rambling speech into the
// request the captain intended — WITHOUT changing meaning, adding content, or
// dropping any specific. When unsure, it keeps the words verbatim.
//
// Backends (captain decision D2): 'gemini' is the DEFAULT (fast, free-tier, already
// the speakability backend on hub); 'minimax' is configurable (the captain okayed it,
// but it is slower and costs credits); 'mock' is the deterministic, offline rule-based
// reference that `npm run validate` asserts with NO network and NO creds.
//
// SAFETY (decision D4): the caller MUST route guard/confirmation (yes/no) utterances
// AROUND this pass — an LLM must never be able to turn a "no" into a "yes". The phone
// leg does exactly that (phone.ts#onUtterance skips cleanup when a consequential
// confirmation is pending); this module has no notion of the guard on purpose.

import { GEMINI_ENDPOINT, GEMINI_MODEL } from '../speakability/speakability.ts';

// The §4.3 cleanup contract. Deliberately conservative: fix, punctuate, structure —
// but never invent, never drop, keep-verbatim when unsure, plain single-line output.
export const CLEANUP_SYSTEM_PROMPT =
  'You clean up dictated speech-to-text before it is sent to a coding agent. The user ' +
  'is a software engineer dictating a request out loud. ' +
  '(1) Fix obvious speech-to-text misrecognitions using software/technical context ' +
  '(e.g. "pole request" or "poll request" -> "pull request", "see eye" -> "CI", ' +
  '"get hub" -> "GitHub", "large V three" -> "large-v3"). ' +
  '(2) Add sentence punctuation and capitalization; remove filler words (um, uh, like, ' +
  'you know) and false starts. ' +
  '(3) Restructure rambling or out-of-order speech into the clear request the speaker ' +
  'intended. ' +
  '(4) Do NOT change the meaning. Do NOT add any requirement, file, flag, or step the ' +
  'speaker did not say. Do NOT drop any specific the speaker did say (names, numbers, ' +
  'paths, flags). ' +
  '(5) If you are unsure what a word was, keep it as transcribed rather than guessing a ' +
  'replacement. ' +
  '(6) Do NOT add markdown, backticks, or code formatting. Output ONLY the cleaned ' +
  'request as plain text on a single line — no preamble, no quotes, no explanation.';

export const MINIMAX_CHAT_ENDPOINT = 'https://api.minimax.io/v1/text/chatcompletion_v2';
export const MINIMAX_CHAT_MODEL = 'MiniMax-Text-01';
// Cleanup sits at turn start on a live call; a slow call aborts and we submit the raw
// transcript rather than stall. Kept tight (report §4.4).
export const CLEANUP_TIMEOUT_MS = 1500;

export type CleanupBackend = 'gemini' | 'minimax' | 'mock';
export type CleanupBackendPref = 'gemini' | 'minimax';

export interface CleanupOptions {
  backend?: CleanupBackend;
  geminiApiKey?: string | null;
  minimaxApiKey?: string | null;
  minimaxGroupId?: string | null;
  model?: string;
  timeoutMs?: number;
  /** Injected fetch (defaults to global). Lets `npm run validate` fake the HTTP. */
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

export interface CleanupResult {
  /** The text to submit — the cleaned prompt, or the RAW transcript on any failure. */
  text: string;
  /** What actually produced `text`. 'raw-fallback' = the LLM path failed and we kept raw. */
  backend: CleanupBackend | 'raw-fallback' | 'noop';
}

// ---- the offline contract, as deterministic code (mock backend) ----------------

// A tiny set of UNAMBIGUOUS, evidence-backed ASR fixes (report §3/§4). Kept minimal on
// purpose: the mock is the contract reference, and a broad dictionary risks changing
// meaning. The real LLM backends handle the long tail.
const ASR_FIXES: Array<[RegExp, string]> = [
  [/\bpo(?:le|ll)\s+request\b/gi, 'pull request'],
  [/\bpull\s+request\b/gi, 'pull request'],
  [/\bsee\s+eye\b/gi, 'CI'],
  [/\b(?:get|git)\s+hub\b/gi, 'GitHub'],
  [/\blarge\s+v\s*(?:three|3)\b/gi, 'large-v3'],
  [/\bvalidation\s+sweet\b/gi, 'validation suite'],
];

// Deterministic rule-based cleaner: obvious fixes, filler removal, immediate-repeat
// collapse, single line, sentence-case, terminal punctuation. Never adds or drops a
// specific. This is the offline reference the harness asserts AND the mock backend.
export function mockCleanup(raw: string): string {
  let s = (raw || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return (raw || '').trim();
  for (const [re, to] of ASR_FIXES) s = s.replace(re, to);
  // Drop standalone filler words (conservative set — never touches meaningful words).
  s = s.replace(/\b(?:um|uh+|erm|uhh|hmm)\b/gi, ' ');
  // Collapse an immediately repeated word ("the the" -> "the"), a common ASR artifact.
  s = s.replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1');
  s = s.replace(/\s+([,.;:?!])/g, '$1').replace(/\s+/g, ' ').trim();
  if (!s) return raw.trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.?!]$/.test(s)) s += '.';
  return s;
}

// Enforce the output invariants and guard against a runaway hallucination. Flattens
// newlines and strips backticks/wrapping quotes in place (contract: single-line, no
// markdown); returns null (-> caller keeps the RAW transcript) when the result is empty
// or has ballooned well past the input (a sign the LLM invented content). Pure.
export function sanitizeCleaned(out: string, rawInput: string): string | null {
  let s = (out || '').replace(/[\r\n]+/g, ' ').replace(/`+/g, '').trim();
  // strip a single pair of wrapping quotes the model sometimes adds
  if (s.length >= 2 && /^["'].*["']$/.test(s)) s = s.slice(1, -1).trim();
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const words = (str: string): number => (str.match(/\S+/g) || []).length;
  const rawWords = words(rawInput);
  const outWords = words(s);
  // Ballooning guard: the cleaner should compress or hold steady, never expand a lot.
  if (rawWords > 0 && outWords > rawWords * 2.5 + 4) return null;
  return s;
}

// ---- backend selection (pure, asserted) ----------------------------------------

// Decision D2/D3 resolution. `enabled` gates whether cleanup runs at all:
//   mode 'off'  -> never;  mode 'on' -> always;  mode 'auto' -> on iff a cleanup key
//   exists (GEMINI or MINIMAX), or the fully-offline mock path is forced.
// `backend`: forceMock wins; else the configured preference when its key exists; else
//   whichever key exists (gemini first, mirroring speakability); else the mock.
export function resolveCleanup(args: {
  mode: 'auto' | 'on' | 'off';
  backendPref: CleanupBackendPref;
  forceMock: boolean;
  hasGemini: boolean;
  hasMinimax: boolean;
}): { enabled: boolean; backend: CleanupBackend } {
  const { mode, backendPref, forceMock, hasGemini, hasMinimax } = args;
  const backend: CleanupBackend =
    forceMock ? 'mock'
      : backendPref === 'minimax' && hasMinimax ? 'minimax'
      : hasGemini ? 'gemini'
      : hasMinimax ? 'minimax'
      : 'mock';
  const enabled =
    mode === 'off' ? false
      : mode === 'on' ? true
      : /* auto */ forceMock || hasGemini || hasMinimax;
  return { enabled, backend };
}

// ---- the cleanup call (NEVER throws) -------------------------------------------

// Clean one raw transcript. ALWAYS resolves: on empty input, network/HTTP error,
// timeout, or a sanity-check failure it returns the RAW transcript so the call is never
// blocked (report §4.4). The mock backend is pure and offline.
export async function cleanPrompt(raw: string, opts: CleanupOptions = {}): Promise<CleanupResult> {
  const input = (raw || '').trim();
  if (!input) return { text: raw, backend: 'noop' };
  const backend = opts.backend ?? 'mock';
  const log = opts.log ?? (() => {});

  if (backend === 'mock') {
    const safe = sanitizeCleaned(mockCleanup(input), input);
    return safe == null ? { text: raw, backend: 'raw-fallback' } : { text: safe, backend: 'mock' };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CLEANUP_TIMEOUT_MS;
  try {
    const out = backend === 'minimax'
      ? await viaMinimax(input, opts.minimaxApiKey || '', opts.minimaxGroupId || '', opts.model ?? MINIMAX_CHAT_MODEL, fetchImpl, timeoutMs)
      : await viaGemini(input, opts.geminiApiKey || '', opts.model ?? GEMINI_MODEL, fetchImpl, timeoutMs);
    const safe = sanitizeCleaned(out, input);
    if (safe == null) {
      log('cleanup: ' + backend + ' output failed sanity check — using raw transcript');
      return { text: raw, backend: 'raw-fallback' };
    }
    return { text: safe, backend };
  } catch (e) {
    log('cleanup: ' + backend + ' failed (' + (e as Error).message + ') — using raw transcript');
    return { text: raw, backend: 'raw-fallback' };
  }
}

// A ready-to-inject cleaner, or null when cleanup is disabled (mode 'off', or 'auto'
// with no cleanup key). The phone/web legs take this as an injected `cleanPrompt`. It
// mirrors the offline-first shape the rest of the product uses (null = today's raw
// behavior). The returned fn NEVER throws and NEVER blocks — it resolves to the cleaned
// text or the raw transcript.
export function makePromptCleaner(args: {
  mode: 'auto' | 'on' | 'off';
  backendPref: CleanupBackendPref;
  forceMock: boolean;
  geminiApiKey?: string | null;
  minimaxApiKey?: string | null;
  minimaxGroupId?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}): { clean: (raw: string) => Promise<string>; backend: CleanupBackend } | null {
  const hasGemini = !!(args.geminiApiKey && args.geminiApiKey.length > 0);
  const hasMinimax = !!(args.minimaxApiKey && args.minimaxApiKey.length > 0);
  const { enabled, backend } = resolveCleanup({
    mode: args.mode, backendPref: args.backendPref, forceMock: args.forceMock, hasGemini, hasMinimax,
  });
  if (!enabled) return null;
  const clean = async (raw: string): Promise<string> => {
    const r = await cleanPrompt(raw, {
      backend,
      geminiApiKey: args.geminiApiKey,
      minimaxApiKey: args.minimaxApiKey,
      minimaxGroupId: args.minimaxGroupId,
      timeoutMs: args.timeoutMs,
      fetchImpl: args.fetchImpl,
      log: args.log,
    });
    return r.text;
  };
  return { clean, backend };
}

// ---- request bodies (pure, asserted) -------------------------------------------

// Gemini generateContent body. thinkingBudget:0 is CRITICAL (gemini-2.5-flash thinks by
// default, eating the output budget -> truncated/empty). Mirrors speakability.
export function geminiCleanupRequestBody(raw: string): unknown {
  return {
    contents: [{ parts: [{ text: CLEANUP_SYSTEM_PROMPT + '\n\nDICTATED TRANSCRIPT:\n' + raw }] }],
    generationConfig: { maxOutputTokens: 200, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
  };
}

// MiniMax chatcompletion_v2 body (OpenAI-shaped). System prompt + the transcript.
export function minimaxCleanupRequestBody(raw: string, model: string = MINIMAX_CHAT_MODEL): unknown {
  return {
    model,
    messages: [
      { role: 'system', content: CLEANUP_SYSTEM_PROMPT },
      { role: 'user', content: 'DICTATED TRANSCRIPT:\n' + raw },
    ],
    max_tokens: 200,
    temperature: 0.2,
  };
}

// ---- network backends ----------------------------------------------------------

async function viaGemini(
  raw: string, apiKey: string, model: string, fetchImpl: typeof fetch, timeoutMs: number,
): Promise<string> {
  if (!apiKey) throw new Error('gemini cleanup requires GEMINI_API_KEY');
  const url = `${GEMINI_ENDPOINT}/${model}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(geminiCleanupRequestBody(raw)),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const out = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text ?? '').join('');
    if (!out.trim()) throw new Error('Gemini returned empty text');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function viaMinimax(
  raw: string, apiKey: string, groupId: string, model: string, fetchImpl: typeof fetch, timeoutMs: number,
): Promise<string> {
  if (!apiKey) throw new Error('minimax cleanup requires MINIMAX_API_KEY');
  const url = `${MINIMAX_CHAT_ENDPOINT}?GroupId=${encodeURIComponent(groupId)}`; // GroupId-in-query gotcha
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(minimaxCleanupRequestBody(raw, model)),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`MiniMax API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      base_resp?: { status_code?: number; status_msg?: string };
    };
    const status = data.base_resp?.status_code ?? 0;
    if (status !== 0) throw new Error(`MiniMax base_resp ${status}: ${data.base_resp?.status_msg || ''}`);
    const out = data.choices?.[0]?.message?.content ?? '';
    if (!out.trim()) throw new Error('MiniMax returned empty text');
    return out;
  } finally {
    clearTimeout(timer);
  }
}
