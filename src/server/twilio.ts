// twilio.ts - the small, pure Twilio surface the phone transport needs.
//
// Three things, all injectable/testable with NO Twilio account:
//   1. TwiML generation - the /phone/twiml webhook answer that bridges the call
//      into our Media Streams WS (`<Connect><Stream url="wss://…/phone">`).
//   2. Webhook authentication - X-Twilio-Signature validation (HMAC-SHA1 over the
//      exact webhook URL + sorted POST params, keyed by the auth token), so a
//      forged POST can't mint a stream token.
//   3. Outbound "Call me" - one REST POST to /2010-04-01/Accounts/<sid>/Calls.json
//      (Basic auth), pointing the call at the same TwiML webhook.
//
// Secrets (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER /
// CEOCHAT_ALLOWED_CALLER / CEOCHAT_PHONE_PIN) come from the gitignored
// ~/.config/ceo-chat/secrets.env via src/config/secrets.ts - never hardcoded.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const TWILIO_API_BASE = 'https://api.twilio.com';

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * TwiML that bridges the answered call into our bidirectional Media Streams WS.
 * `params` ride as <Parameter> elements and come back in the WS `start` frame's
 * customParameters - we use one for the single-use stream token.
 */
export function twimlConnectStream(wsUrl: string, params: Record<string, string> = {}): string {
  const parameters = Object.entries(params)
    .map(([k, v]) => `<Parameter name="${escapeXml(k)}" value="${escapeXml(v)}"/>`)
    .join('');
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Connect><Stream url="${escapeXml(wsUrl)}">${parameters}</Stream></Connect></Response>`;
}

/** TwiML that refuses the call outright (caller not on the allowlist). */
export function twimlReject(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>';
}

/** Parse an application/x-www-form-urlencoded webhook body. */
export function parseFormBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

/**
 * Compute the X-Twilio-Signature for a webhook request: base64(HMAC-SHA1(authToken,
 * url + concat(sorted param names + values))) - Twilio's documented scheme.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

/** Constant-time check of a webhook's X-Twilio-Signature header. */
export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature || '');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Loose phone-number equality: compare digits (with a leading +) only. */
export function sameNumber(a: string | undefined, b: string | undefined): boolean {
  const norm = (n: string | undefined): string => (n || '').replace(/[^\d+]/g, '');
  const na = norm(a);
  const nb = norm(b);
  return na.length > 0 && na === nb;
}

export interface PlaceCallOptions {
  accountSid: string;
  authToken: string;
  /** The Twilio number the call comes FROM. */
  from: string;
  /** The captain's number to ring. */
  to: string;
  /** The TwiML webhook Twilio fetches when the call is answered. */
  twimlUrl: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

export interface PlaceCallResult {
  ok: boolean;
  /** Twilio Call SID on success; error text on failure. */
  detail: string;
}

/** Outbound "Call me": one REST POST that rings the captain. */
export async function placeCall(opts: PlaceCallOptions): Promise<PlaceCallResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.apiBase ?? TWILIO_API_BASE;
  const url = `${base}/2010-04-01/Accounts/${encodeURIComponent(opts.accountSid)}/Calls.json`;
  const body = new URLSearchParams({
    To: opts.to,
    From: opts.from,
    Url: opts.twimlUrl,
    Method: 'POST',
  });
  const auth = Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString('base64');
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) return { ok: false, detail: `Twilio ${res.status}: ${data.message || 'call failed'}` };
    return { ok: true, detail: data.sid || 'queued' };
  } catch (e) {
    return { ok: false, detail: 'Twilio unreachable: ' + (e as Error).message };
  }
}
