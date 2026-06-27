// secrets.mjs — load ceo-chat secrets from a gitignored location OUTSIDE the repo.
//
// Secrets live at ~/.config/ceo-chat/secrets.env (KEY=value, one per line).
// They are NEVER committed and NEVER hardcoded. The eventual broker will load
// them the same way. Phase-0 scripts only ever read names like:
//   MINIMAX_API_KEY, MINIMAX_GROUP_ID, ANTHROPIC_API_KEY
//
// If a key is blank/absent we DON'T throw — callers decide whether to run the
// real credentialed call or gracefully skip (the captain may not have added the
// key yet). See README "pending-creds" sections.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SECRETS_PATH =
  process.env.CEOCHAT_SECRETS ||
  join(homedir(), '.config', 'ceo-chat', 'secrets.env');

// Parse a dotenv-style file. Tolerant: ignores blank lines and `#` comments,
// trims whitespace, strips surrounding single/double quotes from values.
export function loadSecrets(path = SECRETS_PATH) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// True only when a key is present AND non-empty.
export function has(secrets, key) {
  return typeof secrets[key] === 'string' && secrets[key].length > 0;
}
