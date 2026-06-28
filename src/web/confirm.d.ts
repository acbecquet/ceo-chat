// Types for confirm.js — the voice-safety confirmation guard (plan §3.5).
export function looksConsequential(narration: string): boolean;
export function classifyReply(text: string): 'confirm' | 'cancel' | 'unclear';
export interface GuardState {
  source: 'voice' | 'text';
  text: string;
  awaitingConfirmation: boolean;
  lastNarration: string;
}
export type GuardDecision =
  | { action: 'send'; text: string }
  | { action: 'reprompt'; reason: string; speak: string };
export function guardUtterance(state: GuardState): GuardDecision;
