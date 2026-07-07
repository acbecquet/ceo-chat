# Text Mode - SMS/MMS to first mate on the same Twilio number

Text Mode is for when the captain cannot talk: text the Call Mode number and first mate answers by SMS.
Photos and files ride along by MMS, and first mate can proactively text notifications like "PR is green".
For everything you must do to go live (Twilio console, A2P registration, secrets, live tests), open the interactive guide: **`docs/setup-guide.html`** (open the file directly in a browser).

## How it works

```
 iPhone (Messages app)
   <-> Twilio Programmable Messaging (the SAME number as Call Mode)
         Messaging webhook: POST https://ceo-chat.acb-apps.com/text/webhook
   src/server/text.ts (the transport shell; the pipeline below is unchanged)
     inbound : validate X-Twilio-Signature -> allowlist -> fetch MMS media into
               inbox/ -> TurnRunner.run(Body + attachment references, 'sms')
     reply   : Twilio REST Messages.json - the concise speakable summary, within
               the 1600-char limit, plus the web transcript link when the full
               verbatim reply holds more detail (any truncation forces the link)
     proactive: POST /text/notify (bin/text-captain.sh) -> SMS to the captain
```

The text shell reuses the whole existing stack below the Driver seam - the same `TurnRunner`, the same injection, speakability, and transcript tap as the web, phone, and voice legs.
An SMS turn broadcasts to every connected browser too, labeled "you (by text)".

## Using it

- **Text the number.** The Body is injected exactly like a spoken utterance; the reply comes back as an SMS with the same concise summary the voice legs speak.
- **Follow up while it works.** A quick follow-up text while your previous text's turn is still running attaches to it as an addition and the turn re-runs combined; the superseded turn stays silent (no spurious "That turn failed" text), and a superseded MMS turn's attachment-failure note is carried forward to lead the combined reply.
  A turn started from the phone or the web is waited on instead - an inbound text never interrupts a live call.
- **Read the detail on the web.** When the full verbatim reply holds more than the summary, the SMS ends with `Full reply: https://ceo-chat.acb-apps.com`.
  Any reply cut at the 1600-char SMS limit also forces that link - a truncated text always carries the pointer to the full transcript.
- **Send photos/files by MMS.** Each attachment is fetched with authenticated Twilio requests and stored under the gitignored `inbox/` dir; the injected line references the absolute path so first mate opens and inspects exactly what you sent.
  An attachment that fails to download is named by position on both sides: the injected line carries `[WARNING: MMS 1 of 2 attachments (the 2nd) failed to download - you did NOT receive it.]` and the SMS reply leads with `Note: ... - first mate did NOT see it.`, so a partial MMS is never mistaken for the whole one.
- **Get proactive texts.** A first mate session (or any local script) runs:

  ```
  npm run text-captain -- "PR is green"
  ```

  which POSTs `/text/notify` on the running server; the server texts `CEOCHAT_ALLOWED_CALLER` - the captain's own number and nobody else's.
  Gate it off with `CEOCHAT_TEXT_NOTIFY=0` in secrets.env (it is ON by default).

## Security model

- **Webhook authentication is MANDATORY** - `X-Twilio-Signature` (HMAC-SHA1, keyed by the auth token) is validated on every `/text/webhook` POST; Text Mode does not mount at all without `TWILIO_AUTH_TOKEN`.
  A forged POST can never inject into the shell-capable agent.
- **Sender allowlist** - a signed message whose `From` is not `CEOCHAT_ALLOWED_CALLER` is silently dropped: empty TwiML, nothing injected, no reply, nothing revealed.
- **MMS intake caps** - https only, at most 10 media items, 10 MB per file, and the account's Basic auth is attached only for Twilio-owned hosts (never leaked to an arbitrary URL).
- **Notify token** - `/text/notify` requires `x-ceochat-notify: sha256(TWILIO_AUTH_TOKEN)`; the raw Twilio token never rides an HTTP header, and the endpoint can only ever text the captain's allowlisted number.
- **One turn at a time** - an inbound text waits (bounded) on the same serialized turn engine the web and phone legs share; a follow-up to your OWN in-flight text attaches + reinterprets instead of waiting, and a phone/web turn is never interrupted by a text.

## Secrets

Text Mode reuses the Call Mode keys in `~/.config/ceo-chat/secrets.env` (gitignored, never committed): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `CEOCHAT_ALLOWED_CALLER`.
Inbound needs the auth token + allowlist; replies and proactive texts additionally need the account SID + number.
Optional: `CEOCHAT_TEXT_NOTIFY=0` disables the proactive trigger.

## A2P 10DLC - what gates live texting (researched 2026-07-02)

US carriers require A2P 10DLC registration before a local Twilio number may SEND SMS/MMS to US phones.
The full walkthrough with the cost table lives in `docs/setup-guide.html`; the essentials:

- **Registration gates outbound only.** Inbound SMS/MMS to your Twilio number works with no registration ([Shutdown of Unregistered 10DLC Messaging FAQ](https://support.twilio.com/hc/en-us/articles/14910496447771-Shutdown-of-Unregistered-10DLC-Messaging-FAQ)).
  Unregistered outbound US messages have been fully blocked since 2023-09-01, surfacing as [error 30034](https://www.twilio.com/docs/api/errors/30034).
- **The Sole Proprietor tier** fits a personal, low-volume sender: no EIN needed, verified with a mobile-number OTP, one 10DLC number per campaign, throughput fixed at 1 MPS with a T-Mobile cap of 1000 msgs/day ([registration overview](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/direct-sole-proprietor-registration-overview), [throughput](https://help.twilio.com/articles/1260803225669-Message-throughput-MPS-and-Trust-Scores-for-A2P-10DLC-in-the-US)).
- **Timeline:** brand approval typically minutes after the OTP; campaign vetting is manual, plan for about 1-3 weeks ([new-experience overview](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/direct-sole-proprietor-registration-overview-new%20experience)).
- **One-time:** ~$4.50 brand registration + $15 campaign vetting, about $19.50 total ([10DLC product page](https://www.twilio.com/en-us/phone-numbers/a2p-10dlc), [Sole Proprietor FAQ](https://help.twilio.com/articles/9550596959643-New-Changes-to-A2P-10DLC-Starter-Brands-FAQ)).
- **Recurring:** $2.00/mo campaign + $1.15/mo number = $3.15/mo ([product page](https://www.twilio.com/en-us/phone-numbers/a2p-10dlc), [US SMS pricing](https://www.twilio.com/en-us/sms/pricing/us)).
- **Per message** (base + carrier fee, [US SMS pricing](https://www.twilio.com/en-us/sms/pricing/us), live 2026-07-02): outbound SMS $0.0083/segment + $0.0035-0.005 carrier = about $0.012-0.013; outbound MMS $0.022 + up to $0.01 = about $0.03; inbound SMS $0.0083; inbound MMS $0.0165.

So: the captain can text IN (and MMS photos in) the moment the messaging webhook is set, but first mate's SMS replies and proactive texts stay blocked until the Sole Proprietor campaign is approved.

## Validation

`npm run validate` includes mock Text Mode legs (no Twilio account, no network): the mandatory signature gate, the sender allowlist (silent drop), Body -> TurnRunner injection through the same seam as speech, the REST reply framing (narration + transcript link, 1600-char boundary behavior, forced link on any truncation), MMS intake (authenticated fetch, inbox storage, injected references, non-Twilio-host credential protection, https-only, partial-failure naming in both the injected line and the SMS reply), follow-up steering (a second text attaches + re-runs the in-flight SMS turn; a superseded turn sends no spurious failure text while a genuine failure still texts; a superseded MMS turn's failure note is carried forward to lead the combined reply), and the proactive notify trigger (token gate, config gate, REST framing).
Live texting stays captain-gated on A2P registration.
