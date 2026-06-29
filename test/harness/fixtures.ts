// fixtures.ts — synthetic transcript lines + sample agent turns for the harness.
//
// These let the harness drive the transcript tap and speakability deterministically
// (no live claude session required for the offline run). The shapes mirror exactly
// what Claude Code writes (phase0 spike2 / FINDINGS).

export function assistantSay(text: string, ts = '2026-06-27T00:00:00.000Z'): string {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } });
}

export function assistantThinking(text: string, ts = '2026-06-27T00:00:00.000Z'): string {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'thinking', thinking: text }] } });
}

export function assistantToolUse(name: string, input: unknown, id = 'tu_1', ts = '2026-06-27T00:00:00.000Z'): string {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } });
}

export function userPrompt(text: string, ts = '2026-06-27T00:00:00.000Z'): string {
  return JSON.stringify({ type: 'user', timestamp: ts, message: { content: text } });
}

export function userToolResult(id: string, content: unknown, isError = false, ts = '2026-06-27T00:00:00.000Z'): string {
  return JSON.stringify({
    type: 'user', timestamp: ts,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  });
}

export function bookkeeping(kind = 'file-history-snapshot'): string {
  return JSON.stringify({ type: kind, timestamp: '2026-06-27T00:00:00.000Z' });
}

// The canonical agent turn from the phase0 e2e — code path + URL + a decision Q.
export const SAMPLE_AGENT_TURN =
  'The unit tests passed, I edited `src/server.ts`, and the pull request is open ' +
  'at https://example.com/pr/42. Want me to merge it?';

// A turn whose only consequential content is a confirmation question.
export const CONFIRM_TURN =
  'I am about to run `rm -rf ./build` and force-push to origin/main. ' +
  'Should I proceed with the deploy?';

// ─────────────────── speakability DRIFT fixtures (real reply shapes) ─────────
// Built from the captain's live test conversation (data/ceochat-test-convo.md), where
// Gemini summaries drifted on long / multi-topic replies. Each fixture reproduces ONE
// drift pattern; the harness asserts what a CORRECT spoken summary MUST carry. They are
// faithful to the recorded replies (trimmed where the original ran very long). See
// AGENTS.md "Speakability drift".

// 1. MULTI-ASK — two distinct asks in one reply (claim the lock AND install tooling). The
//    drift: the summary keeps one topic and silently drops the other.
export const MULTI_ASK_REPLY =
  "Captain, I'm aboard but holding at the dock — two things need your eye before I can " +
  'take the helm:\n\n' +
  '1. Another session holds the lock. A live session already holds this firstmate’s ' +
  'session lock, so I’m read-only for now. Want me to take over the helm and claim ' +
  'the lock so I can manage work from here?\n\n' +
  "2. Some tooling isn't installed yet. For full operation I’d want gh-axi, " +
  'chrome-devtools-axi, lavish-axi, and no-mistakes — each needs your okay before I ' +
  'install it.\n\n' +
  'Just say the word on either — which session wins the lock, and whether to install the ' +
  'tools.';

// 2. OPTIONS-WITH-RECOMMENDATION — a numbered list where option 1 is the recommendation.
//    The drift: the summary misreports WHICH option was recommended. The three options
//    are a single contiguous block (no blank lines) so the recommendation stays attached.
export const OPTIONS_REPLY =
  "Now I've got the picture, captain. You want `hub` to be the bridge that manages Claude " +
  'agents you run locally on three machines. That cross-machine reach isn’t built ' +
  'yet. A few ways to do it:\n\n' +
  '1. SSH from hub into each machine — hub drives the agents where they already run ' +
  'locally. (My recommendation — it matches working locally on all three but managing ' +
  'them from here.)\n' +
  '2. A firstmate instance per machine, reporting up to hub — more moving parts, but most ' +
  'resilient.\n' +
  '3. Pull the repos onto hub via GitHub — simplest, but then the work happens here, not ' +
  'on those machines.\n\n' +
  'Two quick questions so I steer right: Is Roy bot pushed to GitHub, or purely local? ' +
  'And can hub already reach those three machines over SSH?';

// 3. BURIED-ANSWER — the literal answer ("you're talking to me, this session") is buried
//    under session/lock machinery and a raw PID. The drift: a head-biased summary
//    surfaces the machinery, not the answer; TTS fixates on the PID.
export const BURIED_ANSWER_REPLY =
  "Captain, you're talking to me right now — this session, in your firstmate repo at " +
  '`~/firstmate`.\n\n' +
  "But I'm not the one holding the helm. A separate, older session still owns the session " +
  'lock — process 66035, a long-running daemon alive about a day. Because it holds the ' +
  'lock, I’ve kept myself read-only.\n\n' +
  'If you want this session to be the one in command, say so and I’ll claim the lock.';

// 4. PATH/NUMBER-HEAVY — a file-tree read-out full of paths and counts. The drift: TTS
//    fixates on the paths instead of the point (it's your memoir, 46 entries, what next?).
export const PATH_HEAVY_REPLY =
  "Here's your memoir project, captain — `acb-writing`: 46 entries total, organized " +
  'chronologically (37 from 2024, 7 from 2025, 2 from 2026).\n\n' +
  'Structure: `manuscript/entries/` holds the writing, `manuscript/00-index/` has the ' +
  'Title Page and Timeline, and `editorial/` has review notes with 5 entries reviewed ' +
  'so far. Two source docs sit at the root.\n\n' +
  'What would you like to do with it — read a particular entry, see the themes, or pick ' +
  'up the editorial review where it left off?';

// 5. VERY-LONG MULTI-SECTION — a multi-passage read-out (~3 sections with prose). The
//    drift: impossible to compress to 2 sentences without conflating/dropping; a summary
//    collapses the three stories into one or hallucinates which is which.
export const VERY_LONG_REPLY =
  "Here they are, captain — the first three passages in order.\n\n" +
  '## 1. Lost Friends — 15 April 2024\n' +
  'A story about a dream of a lost childhood friendship with Alex, and years later making ' +
  'peace with how they drifted apart at a graduation party.\n\n' +
  '## 2. Search — 16 to 18 April 2024\n' +
  'A long arc through engineering school, a nuclear-fuel fellowship, growing anxiety, an ' +
  'AI internship, dropping out of grad school during COVID, and being fired in 2022 — ' +
  'closing on the question of whether the writer succeeded or failed.\n\n' +
  '## 3. Greed — 19 April 2024\n' +
  'An epilogue on losing interest in fission work because its progress is driven by ' +
  'politics rather than the fusion energy the writer actually cares about.\n\n' +
  "That's the opening trio, captain. Want me to read the long middle one in full, or move " +
  'on to the next batch?';

// Assertion contract per fixture: every distinct topic must survive (anyOf groups), the
// recommended option must be named, no code/paths/URLs/raw-IDs may be spoken, and a
// pending question must reach the captain. Drives the deterministic mock-quality leg AND
// the live Gemini leg with the SAME expectations.
export interface DriftFixture {
  name: string;
  reply: string;
  /** Each group: the narration must contain at least one of these (case-insensitive). */
  mustMention: string[][];
  /** The option the reply recommends — the narration must name it. */
  recommended?: string;
  /** Substrings that must NEVER be spoken (paths, URLs, backticks, raw PIDs). */
  forbid: string[];
  /** A pending question/decision the summary must preserve. */
  expectQuestion?: boolean;
  /** Cap on spoken sentences (very-long replies still must compress). */
  maxSentences?: number;
}

export const DRIFT_FIXTURES: DriftFixture[] = [
  {
    name: 'multi-ask (lock + tooling) — neither topic dropped',
    reply: MULTI_ASK_REPLY,
    mustMention: [['lock', 'helm', 'read-only'], ['tool', 'install']],
    forbid: ['`'],
    expectQuestion: true,
  },
  {
    name: 'options-with-recommendation — names the RIGHT option',
    reply: OPTIONS_REPLY,
    mustMention: [['ssh']],
    recommended: 'ssh',
    forbid: ['`', 'github.com'],
    expectQuestion: true,
  },
  {
    name: 'buried answer — surfaces the answer, drops the PID',
    reply: BURIED_ANSWER_REPLY,
    mustMention: [['talking to', 'this session', 'connected', 'to me']],
    forbid: ['66035', '`', '~/firstmate'],
  },
  {
    name: 'path/number-heavy — keeps the point, drops the paths',
    reply: PATH_HEAVY_REPLY,
    mustMention: [['memoir', 'entries']],
    forbid: ['`', 'manuscript/', 'editorial/', '00-index'],
    expectQuestion: true,
  },
  {
    name: 'very-long multi-section — compresses, screen-safe',
    reply: VERY_LONG_REPLY,
    mustMention: [['memoir', 'passage', 'lost friends', 'search', 'greed', 'story', 'read']],
    forbid: ['`', 'http', '>'],
    maxSentences: 12,
  },
];

// A long, code-heavy turn to check the rewrite stays short and screen-safe.
export const LONG_CODE_TURN =
  'I refactored the auth module. I changed `src/auth/login.ts`, `src/auth/token.ts`, ' +
  'and updated the tests in `test/auth.spec.ts`. The diff is large — see ' +
  'https://github.com/acme/repo/pull/991 for the full review. I also bumped the ' +
  'version in `package.json` to 2.3.0 and regenerated `pnpm-lock.yaml`. ' +
  'Everything builds and the 412 tests pass.';
