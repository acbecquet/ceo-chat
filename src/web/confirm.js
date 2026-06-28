// confirm.js — voice-safety guard for consequential actions (plan §3.5).
//
// firstmate has shell access; the captain approves merges/pushes/deploys by voice.
// A MISHEARD affirmative must never silently approve an irreversible / outward-facing
// action. So when first mate's spoken turn asks to confirm a consequential action,
// a SPOKEN reply is only forwarded if it is a CLEAR confirm or cancel phrase — not
// "any affirmative noise" (a bare "yeah", background chatter). Anything ambiguous is
// held back and the captain is re-prompted. Typed input is always explicit and passes
// through. Pure + DOM-free so the harness asserts the exact policy.

// Irreversible / outward-facing intents that demand an explicit confirmation.
const CONSEQUENTIAL_RE =
  /\b(merge|merging|merged|push|pushing|force[\s-]?push|deploy|deploying|release|publish|delete|deleting|remove|removing|drop|overwrite|reset|revert|rm\b|sudo|spend|pay|charge|purchase|email|e-mail|send (?:the|an|this|that|it|out)|tweet|post)\b/i;

// A clear GO. Deliberately does NOT include a bare "yes"/"yeah"/"ok"/"sure" — §3.5
// requires more than an affirmative noise for a destructive action.
const CONFIRM_RE =
  /\b(confirm(?:ed|s)?|do it|go ahead|going ahead|proceed|approve[d]?|affirmative|ship it|merge it|push it|send it|deploy it|yes do it|yes please do|yes go ahead|make it so)\b/i;

// A clear STOP. "no" alone counts — erring toward NOT acting is the safe direction.
const CANCEL_RE =
  /\b(cancel|abort|stop|hold (?:on|off)|wait|never\s?mind|do not|don'?t|negative|no thanks|no\b|nope|nah)\b/i;

/** Does this spoken narration ask to confirm a consequential/irreversible action? */
export function looksConsequential(narration) {
  return CONSEQUENTIAL_RE.test(String(narration || ''));
}

/** Classify a captain reply: 'confirm' | 'cancel' | 'unclear'. Cancel wins ties. */
export function classifyReply(text) {
  const t = String(text || '').toLowerCase();
  if (CANCEL_RE.test(t)) return 'cancel';
  if (CONFIRM_RE.test(t)) return 'confirm';
  return 'unclear';
}

/**
 * Decide what to do with a captain utterance given the current call state.
 *   { source: 'voice'|'text', text, awaitingConfirmation, lastNarration }
 * Returns:
 *   { action: 'send', text }              — forward to firstmate
 *   { action: 'reprompt', reason, speak } — hold; ask the captain to be explicit
 * Typed input always sends. Voice during a consequential confirmation must be a
 * clear confirm/cancel; otherwise it's held and re-prompted (never auto-approved).
 */
export function guardUtterance(state) {
  const text = String(state.text || '').trim();
  if (!text) return { action: 'reprompt', reason: 'empty', speak: '' };
  if (state.source === 'text') return { action: 'send', text };
  if (!state.awaitingConfirmation || !looksConsequential(state.lastNarration)) {
    return { action: 'send', text };
  }
  const verdict = classifyReply(text);
  if (verdict === 'unclear') {
    return {
      action: 'reprompt',
      reason: 'ambiguous-confirmation',
      speak: 'I need a clear answer for this one. Say "confirm" to go ahead, or "cancel" to stop.',
    };
  }
  return { action: 'send', text };
}
