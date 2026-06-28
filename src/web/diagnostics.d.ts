// Types for diagnostics.js — the DOM-free ring buffer behind the on-screen panel.
export interface DiagRec {
  ts: number;
  msg: string;
  level: 'info' | 'error';
}
export interface DiagnosticsOptions {
  now?: () => number;
  max?: number;
  onAdd?: (rec: DiagRec) => void;
  onError?: (rec: DiagRec) => void;
}
export class Diagnostics {
  constructor(opts?: DiagnosticsOptions);
  readonly count: number;
  add(msg: string, level?: 'info' | 'error'): DiagRec;
  error(msg: string): DiagRec;
  clear(): void;
  lines(): DiagRec[];
  text(): string;
}
