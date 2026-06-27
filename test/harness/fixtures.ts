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

// A long, code-heavy turn to check the rewrite stays short and screen-safe.
export const LONG_CODE_TURN =
  'I refactored the auth module. I changed `src/auth/login.ts`, `src/auth/token.ts`, ' +
  'and updated the tests in `test/auth.spec.ts`. The diff is large — see ' +
  'https://github.com/acme/repo/pull/991 for the full review. I also bumped the ' +
  'version in `package.json` to 2.3.0 and regenerated `pnpm-lock.yaml`. ' +
  'Everything builds and the 412 tests pass.';
