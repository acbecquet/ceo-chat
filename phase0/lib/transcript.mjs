// transcript.mjs — the clean tap into a Claude Code session transcript.
//
// PROVEN on this machine (see spike2 / FINDINGS): Claude Code writes one JSONL
// file per session under ~/.claude/projects/<cwd-mangled>/<session-uuid>.jsonl,
// appended line-by-line as the turn streams — so it is tail-able in near real
// time. Each line is a JSON object with a top-level `type`:
//   - "assistant": message.content[] of blocks {type: thinking|text|tool_use,...}
//   - "user":      message.content is EITHER a plain string (the human prompt)
//                  OR a list containing {type:"tool_result", tool_use_id, content,
//                  is_error} blocks (the harness feeding tool output back).
//   - plus bookkeeping lines (mode, permission-mode, file-history-snapshot, ...).
//
// This module turns that raw stream into the clean event list the speakability
// layer wants (plan §2/§7): assistant SAY text, tool_use (what the agent is
// doing), and tool_result (outcomes) — with the ANSI/TUI noise of capture-pane
// left behind entirely.

import { readFileSync, existsSync, statSync, readdirSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR ||
  join(homedir(), '.claude', 'projects');

// Map a working-directory path to the mangled project-dir name Claude Code uses
// (every "/" and "." becomes "-"). Lets the broker find the transcript dir for a
// session it just launched in a known cwd.
export function mangleCwd(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

// Newest .jsonl transcript under a project dir (top level only — subagent
// transcripts live in a nested `subagents/` dir we intentionally skip).
export function latestTranscriptIn(projectDir) {
  if (!existsSync(projectDir)) return null;
  const files = readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(projectDir, f))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].p : null;
}

// Newest transcript across ALL projects (used by spike2's default demo).
export function latestTranscriptAnywhere(base = PROJECTS_DIR) {
  if (!existsSync(base)) return null;
  let best = null;
  for (const d of readdirSync(base)) {
    const dir = join(base, d);
    if (!statSync(dir).isDirectory()) continue;
    const t = latestTranscriptIn(dir);
    if (t) {
      const m = statSync(t).mtimeMs;
      if (!best || m > best.mtime) best = { path: t, mtime: m };
    }
  }
  return best ? best.path : null;
}

// Normalize ONE raw JSONL object into zero or more clean events.
// Event shapes (all carry ts + role for ordering/debugging):
//   { kind: 'say',          role, ts, text }                     // assistant prose
//   { kind: 'thinking',     role, ts, text }                     // assistant reasoning
//   { kind: 'tool_use',     role, ts, id, name, input }          // what the agent runs
//   { kind: 'tool_result',  role, ts, id, isError, text }        // outcome (truncated)
//   { kind: 'human',        role, ts, text }                     // the captain's prompt
export function normalizeLine(obj, { resultMax = 400 } = {}) {
  const ts = obj.timestamp || null;
  const events = [];
  if (obj.type === 'assistant') {
    const content = obj.message?.content || [];
    for (const b of content) {
      if (b.type === 'text' && b.text?.trim()) {
        events.push({ kind: 'say', role: 'assistant', ts, text: b.text });
      } else if (b.type === 'thinking' && b.thinking?.trim?.()) {
        events.push({ kind: 'thinking', role: 'assistant', ts, text: b.thinking });
      } else if (b.type === 'tool_use') {
        events.push({
          kind: 'tool_use',
          role: 'assistant',
          ts,
          id: b.id,
          name: b.name,
          input: b.input,
        });
      }
    }
  } else if (obj.type === 'user') {
    const content = obj.message?.content;
    if (typeof content === 'string') {
      if (content.trim()) {
        events.push({ kind: 'human', role: 'user', ts, text: content });
      }
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_result') {
          const text = stringifyResult(b.content);
          events.push({
            kind: 'tool_result',
            role: 'tool',
            ts,
            id: b.tool_use_id,
            isError: !!b.is_error,
            text: text.length > resultMax ? text.slice(0, resultMax) + '…' : text,
          });
        } else if (b?.type === 'text' && b.text?.trim()) {
          events.push({ kind: 'human', role: 'user', ts, text: b.text });
        }
      }
    }
  }
  return events;
}

// tool_result.content is sometimes a string, sometimes a list of content blocks.
function stringifyResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : b?.text ?? JSON.stringify(b)))
      .join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

// Parse a whole transcript file into a flat, ordered event list.
export function parseTranscript(path, opts) {
  const events = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // partially-written trailing line; skip
    }
    events.push(...normalizeLine(obj, opts));
  }
  return events;
}

// Near-real-time tail. Reads from `startOffset` bytes, then watches the file and
// emits normalized events for each newly-appended COMPLETE line. Returns a stop()
// function. Robust to the writer appending mid-line: we buffer a partial last
// line until its newline arrives.
export function tailTranscript(path, onEvent, { startOffset = 0, opts } = {}) {
  let offset = startOffset;
  let buf = '';
  const pump = () => {
    let size;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const fd = readFileSync(path); // simple + fine for spike-scale files
    const chunk = fd.subarray(offset).toString('utf8');
    offset = fd.length;
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop(); // keep trailing partial
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        for (const ev of normalizeLine(obj, opts)) onEvent(ev);
      } catch {
        /* skip malformed */
      }
    }
  };
  pump();
  const watcher = watch(path, { persistent: true }, pump);
  // Also poll: fs.watch can miss appends on some filesystems / over NFS.
  const timer = setInterval(pump, 250);
  return () => {
    watcher.close();
    clearInterval(timer);
  };
}
