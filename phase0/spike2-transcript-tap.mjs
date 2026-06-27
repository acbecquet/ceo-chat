#!/usr/bin/env node
// spike2-transcript-tap.mjs — confirm Claude Code writes a readable session
// transcript and that we can cleanly extract assistant text + tool events.
//
// PROVES (plan §2/§7 linchpin): the speakability layer can consume the structured
// transcript JSONL instead of scraping the ANSI/redraw-laden TUI. We locate a
// real transcript on hub, parse it into a clean event stream, and (optionally)
// tail it in near-real-time.
//
// RUN:
//   node phase0/spike2-transcript-tap.mjs                 # parse newest transcript
//   node phase0/spike2-transcript-tap.mjs <file.jsonl>    # parse a specific one
//   node phase0/spike2-transcript-tap.mjs --follow <file> # near-real-time tail
// No creds required.

import { existsSync } from 'node:fs';
import {
  PROJECTS_DIR, latestTranscriptAnywhere, parseTranscript, tailTranscript,
} from './lib/transcript.mjs';

const args = process.argv.slice(2);
const follow = args.includes('--follow');
const pathArg = args.find((a) => a.endsWith('.jsonl'));

function oneLine(ev) {
  const t = (ev.text || '').replace(/\s+/g, ' ').trim();
  switch (ev.kind) {
    case 'say':         return `🗣️  SAY        ${clip(t, 160)}`;
    case 'thinking':    return `💭 (thinking)  ${clip(t, 80)}`;
    case 'tool_use':    return `🔧 TOOL_USE    ${ev.name}  ${clip(JSON.stringify(ev.input), 100)}`;
    case 'tool_result': return `📤 RESULT${ev.isError ? '❗' : ' '}     ${clip(t, 100)}`;
    case 'human':       return `👤 CAPTAIN     ${clip(t, 120)}`;
    default:            return `?  ${ev.kind}`;
  }
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

const target = pathArg || latestTranscriptAnywhere();
if (!target || !existsSync(target)) {
  console.error('No transcript found under', PROJECTS_DIR);
  process.exit(1);
}
console.log('transcript:', target, '\n');

if (follow) {
  console.log('Tailing for new events (Ctrl-C to stop)…\n');
  const stop = tailTranscript(target, (ev) => console.log(oneLine(ev)), {
    startOffset: 0,
  });
  process.on('SIGINT', () => { stop(); process.exit(0); });
} else {
  const events = parseTranscript(target);
  const counts = {};
  for (const ev of events) counts[ev.kind] = (counts[ev.kind] || 0) + 1;
  console.log('event counts:', JSON.stringify(counts), '\n');

  // Show the clean speakability-source stream (the say/tool events that matter),
  // capped so the demo stays readable.
  const interesting = events.filter((e) =>
    ['say', 'tool_use', 'tool_result', 'human'].includes(e.kind));
  console.log(`--- clean event stream (${interesting.length} events; showing last 25) ---`);
  for (const ev of interesting.slice(-25)) console.log(oneLine(ev));

  console.log('\n✅ Transcript tap works: assistant text + tool_use + tool_result extracted cleanly.');
}
