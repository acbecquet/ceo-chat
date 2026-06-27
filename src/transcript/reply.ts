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
