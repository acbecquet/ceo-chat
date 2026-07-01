// Types for prompt-card.js (the .js stays plain ESM so the browser loads it raw).

export interface VerbatimSegment {
  kind: 'plain' | 'code';
  text: string;
}

/** Lossless split: concatenating segment texts reproduces the input byte-exact. */
export function splitFencedSegments(text: string): VerbatimSegment[];

export interface PromptOption {
  label: string;
  /** The text a tap submits (equivalent to speaking it). */
  send: string;
}

export interface ExtractedPrompt {
  question: string;
  options: PromptOption[];
}

/** Derive the sticky answer card from the final verbatim reply, or null. */
export function extractPrompt(verbatimText: string): ExtractedPrompt | null;
