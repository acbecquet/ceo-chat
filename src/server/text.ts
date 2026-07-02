// text.ts - Text Mode: SMS/MMS to first mate on the SAME Twilio number as Call
// Mode, for when the captain cannot talk.
//
// This is a transport shell in the phone.ts mold - everything below the Driver
// seam is UNCHANGED. An inbound text is injected through the shared TurnRunner
// exactly like a spoken utterance or a typed web line, and the reply that comes
// back is the same speakability narration the voice legs speak:
//
//   Twilio Messaging webhook -> POST /text/webhook
//     validate X-Twilio-Signature (MANDATORY - the broker fronts a shell-capable
//     agent) -> reject From != CEOCHAT_ALLOWED_CALLER -> fetch MMS media into the
//     gitignored inbox/ -> TurnRunner.run(Body + attachment references, 'sms')
//   reply -> Twilio REST Messages.json: the concise narration, within the
//     1600-char limit, plus the web transcript link when the verbatim reply
//     holds more detail than the summary.
//   proactive -> POST /text/notify (config-gated, default ON): first mate texts
//     the captain notifications ("PR is green") via bin/text-captain.sh.
//
// SECURITY, layered like the phone leg:
//   1. X-Twilio-Signature validation on /text/webhook - ALWAYS on. Text Mode does
//      not mount without the auth token, so a forged POST can never inject.
//   2. Sender allowlist: From must be CEOCHAT_ALLOWED_CALLER or the message is
//      dropped (empty TwiML, nothing injected, no reply).
//   3. MMS media is fetched over https only, Basic auth is attached ONLY for
//      Twilio-owned hosts, and per-file/count caps bound the intake.
//   4. /text/notify needs the x-ceochat-notify token (sha256 of the auth token) -
//      the tunnel-exposed endpoint can never be used by strangers, and it can
//      only ever text the captain's own allowlisted number.
//   5. Turns stay serialized: an inbound text waits for the shared TurnRunner
//      busy lock (bounded), so SMS/phone/web can never interleave injections.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PhoneSecrets } from '../config/secrets.ts';
import { textCapabilities } from '../config/secrets.ts';
import type { TurnRunner } from './turns.ts';
import { parseFormBody, validateTwilioSignature, sameNumber, sendSms } from './twilio.ts';

export const TEXT_WEBHOOK_PATH = '/text/webhook';
export const TEXT_NOTIFY_PATH = '/text/notify';

// Twilio caps one Message Body at 1600 characters (it segments on the wire; past
// 1600 the REST API rejects with error 21617). Everything we send stays inside it.
export const SMS_BODY_LIMIT = 1600;

// Twilio delivers at most 10 media items per inbound MMS; cap each file so a
// hostile payload can never balloon the inbox (Twilio's own MMS cap is ~5MB).
const MAX_MEDIA_ITEMS = 10;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_WEBHOOK_BODY = 64 * 1024;

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_INBOX_DIR = join(HERE, '..', '..', 'inbox');

/**
 * The auth for the proactive /text/notify trigger: sha256(TWILIO_AUTH_TOKEN) hex.
 * Derived, not stored - the trigger script recomputes it from secrets.env, and the
 * raw Twilio token itself never rides an HTTP header.
 */
export function notifyToken(authToken: string): string {
  return createHash('sha256').update(authToken, 'utf8').digest('hex');
}

/** File extension for an MMS content type (fallback: .bin). Pure. */
export function mediaExtension(contentType: string): string {
  const ct = (contentType || '').split(';')[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/bmp': 'bmp',
    'image/tiff': 'tiff', 'application/pdf': 'pdf', 'text/vcard': 'vcf',
    'text/x-vcard': 'vcf', 'text/plain': 'txt', 'text/csv': 'csv',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/amr': 'amr',
    'audio/wav': 'wav', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
  };
  return map[ct] || 'bin';
}

export interface SavedMedia {
  /** Absolute path in the inbox - what first mate opens. */
  path: string;
  contentType: string;
  bytes: number;
}

/**
 * The single line injected into the session for an inbound text. One line only -
 * the real broker path submits via fm-send, where an embedded newline would split
 * the message. Attachment references carry the absolute inbox path so first mate
 * can open and inspect exactly what the captain sent. Pure.
 */
export function buildInjectedText(body: string, media: SavedMedia[]): string {
  const parts: string[] = [];
  const text = (body || '').replace(/\s+/g, ' ').trim();
  if (text) parts.push(text);
  if (media.length > 0) {
    if (!text) parts.push(`The captain texted ${media.length} attachment${media.length === 1 ? '' : 's'} (no message text).`);
    media.forEach((m, i) => {
      parts.push(`[MMS attachment ${i + 1}/${media.length} from the captain: ${m.path} (${m.contentType}) - open and inspect it.]`);
    });
  }
  return parts.join(' ');
}

/**
 * The SMS reply body: the concise speakable narration, within Twilio's 1600-char
 * limit. When the full verbatim reply holds more detail than the summary, the web
 * transcript link is appended so the captain can read the exact response. The
 * link always survives truncation. Pure.
 */
export function formatSmsReply(
  narration: string,
  verbatim: string,
  webUrl: string,
  limit: number = SMS_BODY_LIMIT,
): string {
  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const full = (verbatim || '').trim();
  let base = (narration || '').trim() || full;
  const needLink = !!full && normalize(full) !== normalize(base);
  const suffix = needLink ? `\n\nFull reply: ${webUrl}` : '';
  if (base.length + suffix.length > limit) {
    base = base.slice(0, Math.max(0, limit - suffix.length - 1)).trimEnd() + '…';
  }
  return (base + suffix).slice(0, limit);
}

// ── the transport ──────────────────────────────────────────────────────────────

export interface TextAppOptions {
  runner: TurnRunner;
  secrets: PhoneSecrets;
  /** Public origin the tunnel serves (e.g. https://ceo-chat.acb-apps.com). */
  publicUrl: string;
  /** Where inbound MMS media lands. Gitignored; default <repo>/inbox. */
  inboxDir?: string;
  /** The proactive /text/notify trigger (CEOCHAT_TEXT_NOTIFY). Default: on. */
  notifyEnabled?: boolean;
  /** How long an inbound text waits on the shared turn lock before giving up. */
  busyTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface TextApp {
  readonly capabilities: { inbound: boolean; outbound: boolean };
  readonly notifyEnabled: boolean;
  /** Handle /text/* HTTP (webhook + notify). Returns false when not a text path. */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean;
  /** Proactive outbound notification: text the captain via Twilio REST. */
  notify(text: string): Promise<{ ok: boolean; detail: string }>;
}

export function createTextApp(opts: TextAppOptions): TextApp {
  const runner = opts.runner;
  const secrets = opts.secrets;
  const log = opts.log ?? (() => {});
  const capabilities = textCapabilities(secrets);
  const publicUrl = opts.publicUrl.replace(/\/+$/, '');
  const webhookUrl = publicUrl + TEXT_WEBHOOK_PATH;
  const inboxDir = resolve(opts.inboxDir ?? DEFAULT_INBOX_DIR);
  const notifyOn = opts.notifyEnabled ?? true;
  const busyTimeoutMs = opts.busyTimeoutMs ?? 180 * 1000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolveBody) => {
      let body = '';
      req.on('data', (d: Buffer) => {
        body += d.toString();
        if (body.length > MAX_WEBHOOK_BODY) req.destroy();
      });
      req.on('end', () => resolveBody(body));
      req.on('error', () => resolveBody(body));
    });

  const json = (res: ServerResponse, status: number, obj: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
  };

  // The messaging webhook answer that means "no auto-reply" - real replies go out
  // through REST after the (long-running) turn completes, far past the webhook's
  // 15-second response window.
  const emptyTwiml = (res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'text/xml' })
      .end('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  };

  /** Text the captain (used by replies, failure notes, and /text/notify). */
  async function textCaptain(body: string): Promise<{ ok: boolean; detail: string }> {
    if (!capabilities.outbound) {
      const detail = 'outbound texting not configured (need TWILIO_ACCOUNT_SID + TWILIO_PHONE_NUMBER)';
      log('text: ' + detail);
      return { ok: false, detail };
    }
    const result = await sendSms({
      accountSid: secrets.accountSid!,
      authToken: secrets.authToken!,
      from: secrets.phoneNumber!,
      to: secrets.allowedCaller!,
      body: body.slice(0, SMS_BODY_LIMIT),
      fetchImpl,
    });
    log(result.ok ? `text: sent (${result.detail})` : `text: send FAILED - ${result.detail}`);
    return result;
  }

  /** Fetch one MMS media item into the inbox. Basic auth only for Twilio hosts. */
  async function fetchMediaToInbox(
    url: string,
    declaredType: string,
    messageSid: string,
    index: number,
  ): Promise<SavedMedia> {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('media URL is not https');
    const headers: Record<string, string> = {};
    if (/(^|\.)twilio\.com$/.test(u.hostname) && secrets.accountSid && secrets.authToken) {
      // Twilio media needs the account's Basic auth; undici drops the header on the
      // cross-origin redirect to the signed S3 URL, so it never leaks off-Twilio.
      headers.Authorization =
        'Basic ' + Buffer.from(`${secrets.accountSid}:${secrets.authToken}`).toString('base64');
    }
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`media fetch failed: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES) throw new Error(`media too large (${bytes.length} bytes)`);
    const contentType =
      (res.headers.get('content-type') || declaredType || 'application/octet-stream').split(';')[0]!.trim();
    mkdirSync(inboxDir, { recursive: true });
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const sid = (messageSid || 'msg').replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'msg';
    const path = join(inboxDir, `${stamp}-${sid}-${index}.${mediaExtension(contentType)}`);
    writeFileSync(path, bytes);
    log(`text: saved MMS media ${index} -> ${path} (${contentType}, ${bytes.length} bytes)`);
    return { path, contentType, bytes: bytes.length };
  }

  /** Run the injected text once the shared turn lock frees up (bounded wait). */
  async function runWhenFree(text: string): Promise<{ ok: boolean; turn: number }> {
    const t0 = now();
    for (;;) {
      if (!runner.busy) {
        const r = await runner.run(text, 'sms');
        // ok, or it genuinely ran and failed mid-turn (turn > 0): both are final.
        // turn === 0 means the run never started (lost a busy race) - keep waiting.
        if (r.ok || r.turn > 0) return r;
      }
      if (now() - t0 >= busyTimeoutMs) return { ok: false, turn: 0 };
      await sleep(250);
    }
  }

  /** The full inbound flow, detached from the webhook response. */
  async function handleInbound(params: Record<string, string>): Promise<void> {
    const body = (params.Body || '').trim();
    const numMedia = Math.min(
      Math.max(Number.parseInt(params.NumMedia || '0', 10) || 0, 0),
      MAX_MEDIA_ITEMS,
    );
    const media: SavedMedia[] = [];
    let mediaFailures = 0;
    for (let i = 0; i < numMedia; i++) {
      const url = params[`MediaUrl${i}`];
      if (!url) continue;
      try {
        media.push(await fetchMediaToInbox(
          url,
          params[`MediaContentType${i}`] || '',
          params.MessageSid || params.SmsSid || '',
          i,
        ));
      } catch (e) {
        mediaFailures++;
        log(`text: MMS media ${i} intake FAILED - ${(e as Error).message}`);
      }
    }

    const text = buildInjectedText(body, media);
    if (!text) {
      log('text: inbound message had no usable content - nothing injected');
      await textCaptain(
        mediaFailures > 0
          ? 'I could not read that message: the attachment fetch failed and there was no text.'
          : 'I received an empty text - nothing to do.',
      );
      return;
    }

    const result = await runWhenFree(text);
    if (result.turn === 0) {
      await textCaptain('first mate is mid-turn and stayed busy - text again in a minute.');
      return;
    }
    if (!result.ok) {
      await textCaptain(`That turn failed - check the transcript at ${publicUrl}`);
      return;
    }
    const rec = runner.history.find((r) => r.turn === result.turn);
    const replyBody = formatSmsReply(rec?.narration ?? '', rec?.verbatim || rec?.reply || '', publicUrl);
    if (replyBody) await textCaptain(replyBody);
  }

  function answerWebhook(req: IncomingMessage, res: ServerResponse): void {
    void readBody(req).then((body) => {
      const params = parseFormBody(body);
      // MANDATORY webhook authentication - Text Mode never mounts without the auth
      // token, and there is no opt-out: a forged POST can never reach the agent.
      const sig = String(req.headers['x-twilio-signature'] || '');
      if (!secrets.authToken || !validateTwilioSignature(secrets.authToken, webhookUrl, params, sig)) {
        log('text: webhook REFUSED - bad X-Twilio-Signature');
        res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
        return;
      }
      if (!secrets.allowedCaller || !sameNumber(params.From, secrets.allowedCaller)) {
        log(`text: message DROPPED - sender not allowlisted (From=${params.From || '?'})`);
        emptyTwiml(res); // silent drop: no injection, no reply, nothing revealed
        return;
      }
      // Answer Twilio NOW (no auto-reply TwiML); the turn runs long past the
      // webhook window and the real reply goes out via REST when it finishes.
      emptyTwiml(res);
      void handleInbound(params).catch((e) => log('text: inbound flow failed - ' + (e as Error).message));
    });
  }

  function answerNotify(req: IncomingMessage, res: ServerResponse): void {
    void readBody(req).then(async (body) => {
      if (!notifyOn) {
        json(res, 404, { ok: false, detail: 'proactive texts disabled (CEOCHAT_TEXT_NOTIFY=0)' });
        return;
      }
      const given = String(req.headers['x-ceochat-notify'] || '');
      if (!secrets.authToken || given !== notifyToken(secrets.authToken)) {
        log('text: notify REFUSED - bad x-ceochat-notify token');
        json(res, 403, { ok: false, detail: 'forbidden' });
        return;
      }
      let text = '';
      if (/application\/json/i.test(String(req.headers['content-type'] || ''))) {
        try { text = String((JSON.parse(body) as { text?: unknown }).text ?? ''); } catch { text = ''; }
      } else {
        text = parseFormBody(body).text || '';
      }
      text = text.trim();
      if (!text) {
        json(res, 400, { ok: false, detail: 'missing text' });
        return;
      }
      const result = await app.notify(text);
      json(res, result.ok ? 200 : 502, result);
    });
  }

  const app: TextApp = {
    capabilities,
    notifyEnabled: notifyOn,

    handleHttp(req, res): boolean {
      const path = (req.url || '/').split('?')[0]!;
      if (!path.startsWith('/text')) return false;
      if (path === TEXT_WEBHOOK_PATH && req.method === 'POST') {
        answerWebhook(req, res);
      } else if (path === TEXT_NOTIFY_PATH && req.method === 'POST') {
        answerNotify(req, res);
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      }
      return true;
    },

    async notify(text): Promise<{ ok: boolean; detail: string }> {
      const trimmed = (text || '').trim();
      if (!trimmed) return { ok: false, detail: 'missing text' };
      log(`text: proactive notification -> captain: "${trimmed.slice(0, 80)}"`);
      return textCaptain(trimmed);
    },
  };
  return app;
}
