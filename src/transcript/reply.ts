// reply.ts — wait for a COMPLETE new agent turn on the transcript tap.
//
// BUG-FIX (regression-guarded): the "reply-wait latch". A new `say` block appears
// in the transcript WHILE the turn is still streaming — if we return on first sight
// we capture a PARTIAL reply (and speak half a sentence). The latch requires BOTH:
//   (1) the say-count grew past the baseline, AND
//   (2) after a short settle, the harness is IDLE again (claude shows
//       "esc to interrupt" only while a turn is streaming).
// Only then do we read the (now-complete) say text. See test/legs for the guard.
//
// Logic is injectable (readSays / isIdle / sleep) so it can be driven
// deterministically in tests AND wired to the real transcript+pane in the broker.

export interface WaitForReplyDeps {
  /** Current count + concatenated text of `say` blocks in the transcript. */
  readSays: () => { count: number; text: string };
  /** Is the harness idle (turn finished)? false while streaming. */
  isIdle: () => boolean | Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log?: (msg: string) => void;
}

export interface WaitForReplyOpts {
  sayBefore: number;
  timeoutMs?: number;
  settleMs?: number;
  pollMs?: number;
}

// Split a streaming text buffer into COMPLETE speakable units (sentence- or
// say-block-boundary terminated) plus the trailing partial `rest` to hold until more
// arrives. A unit ends at sentence punctuation (.!?) followed by whitespace/EOL, or at
// a newline (a say-block boundary in the joined transcript). This is what lets us speak
// the first sentence ~1s in instead of waiting for the whole turn — never mid-word.
export function splitCompleteUnits(buffer: string): { units: string[]; rest: string } {
  const units: string[] = [];
  let lastEnd = 0;
  // Each match = text up to and including a sentence terminator (.!? followed by
  // whitespace/EOL — so decimals/abbrevs like "v2.1" don't split) OR a newline.
  const re = /[^\n.!?]*(?:[.!?]+(?=\s|$)|\n)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    if (re.lastIndex === m.index) { re.lastIndex++; continue; } // guard zero-width
    const u = m[0].trim();
    if (u) units.push(u);
    lastEnd = re.lastIndex;
  }
  return { units, rest: buffer.slice(lastEnd) };
}

// Split a streaming buffer into COMPLETE topic blocks (paragraphs separated by a blank
// line), holding the trailing partial block in `rest` until a blank line terminates it
// (or the turn ends and it's flushed). This is the granularity the broker speaks at:
// summarizing a whole topic at once — not each sentence — is what stops the Gemini drift
// where a fragment loses which option was recommended or silently drops the other ask.
// A contiguous list (e.g. "1. … 2. … 3. …" with no blank lines) stays ONE block, so its
// recommendation is never separated from its options. See AGENTS.md "Speakability drift".
export function splitCompleteBlocks(buffer: string): { units: string[]; rest: string } {
  const units: string[] = [];
  let lastEnd = 0;
  // Each match = text up to (non-greedy) a blank-line block terminator.
  const re = /([\s\S]*?)\n[ \t]*\n+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buffer)) !== null) {
    if (re.lastIndex === m.index) { re.lastIndex++; continue; } // guard zero-width
    const b = m[1]!.trim();
    if (b) units.push(b);
    lastEnd = re.lastIndex;
  }
  return { units, rest: buffer.slice(lastEnd) };
}

const unitKey = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

export type UnitSplitter = (buffer: string) => { units: string[]; rest: string };

export interface StreamReplyDeps extends WaitForReplyDeps {
  /** Called with each COMPLETE speakable unit as it becomes available (progressive). */
  onUnit: (unitText: string) => void;
  /**
   * How to carve the streaming buffer into units. Default: sentence/newline boundaries
   * (splitCompleteUnits). The broker passes splitCompleteBlocks so each unit is a whole
   * topic block — enough context for the rewriter to not drift.
   */
  split?: UnitSplitter;
  /** Barge-in / hangup: when aborted, stop streaming and return what we have. */
  signal?: { readonly aborted: boolean };
}

// Like waitForReply, but emits complete speakable units PROGRESSIVELY as the agent's
// reply streams in (onUnit), instead of returning only the finished turn. Dedups so a
// transcript rotation that re-reads text never double-speaks, holds partial sentences
// until complete, flushes the remainder when the harness goes idle, and returns the
// full concatenated reply. Injectable (readSays/isIdle/sleep/now) like waitForReply.
export async function streamReply(
  deps: StreamReplyDeps,
  { sayBefore, timeoutMs = 150000, settleMs = 2000, pollMs = 1000 }: WaitForReplyOpts,
): Promise<string> {
  const { readSays, isIdle, sleep, now, onUnit } = deps;
  const split = deps.split ?? splitCompleteUnits;
  const log = deps.log ?? (() => {});
  const start = now();
  const seen = new Set<string>();   // normalized units already spoken — dedup across
  const order: string[] = [];       // transcript rotations (re-reads never double-speak)

  // Emit every COMPLETE unit in `text` we haven't spoken yet. `flush` also speaks the
  // trailing partial (turn is done, nothing more is coming). Dedup is what makes a
  // mid-turn transcript rotation (re-reading the reply from a fresh file) a non-event.
  const pump = (text: string, flush: boolean): void => {
    const { units, rest } = split(text);
    const all = flush && rest.trim() ? [...units, rest.trim()] : units;
    for (const u of all) {
      const key = unitKey(u);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      order.push(u);
      onUnit(u);
    }
  };

  while (now() - start < timeoutMs) {
    if (deps.signal?.aborted) {
      log('streamReply aborted (barge-in/hangup)');
      return order.join(' ').replace(/\s+/g, ' ').trim();
    }
    const cur = readSays();
    if (cur.count > sayBefore) {
      // Speak complete units as they stream — don't wait for the whole turn (the fix).
      pump(cur.text, false);
      await sleep(settleMs);
      const idle = await isIdle();
      const after = readSays();
      if (after.count > sayBefore && idle) {
        pump(after.text, true); // turn done — flush the final partial sentence
        log('reply complete (harness idle) — streamed ' + order.length + ' unit(s)');
        const full = order.join(' ').replace(/\s+/g, ' ').trim();
        return full || after.text.trim();
      }
      log('say streaming — emitted ' + order.length + ' unit(s) so far (holding for more)');
    }
    await sleep(pollMs);
  }
  throw new Error('timed out waiting for agent reply');
}

export async function waitForReply(
  deps: WaitForReplyDeps,
  { sayBefore, timeoutMs = 150000, settleMs = 2000, pollMs = 1000 }: WaitForReplyOpts,
): Promise<string> {
  const { readSays, isIdle, sleep, now } = deps;
  const log = deps.log ?? (() => {});
  const start = now();
  while (now() - start < timeoutMs) {
    const seen = readSays();
    if (seen.count > sayBefore) {
      // A new say block landed — but the turn may still be streaming. Settle, then
      // require IDLE before trusting the text is complete (the latch).
      await sleep(settleMs);
      const idle = await isIdle();
      const after = readSays();
      if (after.count > sayBefore && idle) {
        log('reply complete (harness idle)');
        return after.text.trim();
      }
      log('say seen but harness still streaming — holding (latch)');
    }
    await sleep(pollMs);
  }
  throw new Error('timed out waiting for agent reply');
}
