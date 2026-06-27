// report.ts — a tiny, dependency-free PASS/FAIL reporter for the e2e harness.
//
// The validation harness is the product's centerpiece, so its output has to be
// instantly readable: one block per leg, a tick/cross per assertion, then an
// overall summary. A leg can also be PENDING (expected-degraded) — used by --live
// when MiniMax is reachable but the credential pairing is not yet done (1004).

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string): string => (useColor ? `[${code}m${s}[0m` : s);
const green = (s: string) => c('32', s);
const red = (s: string) => c('31', s);
const yellow = (s: string) => c('33', s);
const dim = (s: string) => c('2', s);
const bold = (s: string) => c('1', s);

export type LegStatus = 'pass' | 'fail' | 'pending' | 'skip';

interface Check {
  ok: boolean;
  desc: string;
  detail?: string;
}

interface LegRecord {
  name: string;
  status: LegStatus;
  checks: Check[];
  ms: number;
  note?: string;
}

// The assertion surface handed to each leg.
export class Asserter {
  readonly checks: Check[] = [];
  private pendingReason: string | null = null;

  ok(cond: boolean, desc: string, detail?: string): boolean {
    this.checks.push({ ok: !!cond, desc, detail: cond ? undefined : detail });
    return !!cond;
  }
  eq<T>(actual: T, expected: T, desc: string): boolean {
    const ok = Object.is(actual, expected);
    return this.ok(ok, desc, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  includes(haystack: string, needle: string, desc: string): boolean {
    return this.ok(haystack.includes(needle), desc, `"${needle}" not found`);
  }
  notIncludes(haystack: string, needle: string, desc: string): boolean {
    return this.ok(!haystack.includes(needle), desc, `"${needle}" should NOT be present`);
  }
  // Mark this leg PENDING (expected-degraded), e.g. live MiniMax reachable but
  // creds not yet paired. Non-fatal to the overall run.
  pending(reason: string): void {
    this.pendingReason = reason;
  }
  get _pendingReason(): string | null {
    return this.pendingReason;
  }
}

export class Reporter {
  private legs: LegRecord[] = [];
  private readonly mode: 'mock' | 'live';
  constructor(mode: 'mock' | 'live') {
    this.mode = mode;
  }

  header(): void {
    console.log('');
    console.log(bold(`ceo-chat end-to-end validation  ·  ${this.mode.toUpperCase()} mode`));
    console.log(dim('─'.repeat(64)));
  }

  async leg(name: string, fn: (t: Asserter) => Promise<void> | void): Promise<void> {
    const t = new Asserter();
    const start = performance.now();
    let status: LegStatus;
    let note: string | undefined;
    try {
      await fn(t);
      const failed = t.checks.some((ch) => !ch.ok);
      if (failed) status = 'fail';
      else if (t._pendingReason) { status = 'pending'; note = t._pendingReason; }
      else status = 'pass';
    } catch (e) {
      status = 'fail';
      t.checks.push({ ok: false, desc: 'leg threw', detail: (e as Error).message });
    }
    const ms = Math.round(performance.now() - start);
    this.legs.push({ name, status, checks: t.checks, ms, note });
    this.printLeg(this.legs[this.legs.length - 1]!);
  }

  skip(name: string, reason: string): void {
    this.legs.push({ name, status: 'skip', checks: [], ms: 0, note: reason });
    this.printLeg(this.legs[this.legs.length - 1]!);
  }

  private badge(s: LegStatus): string {
    switch (s) {
      case 'pass': return green('PASS');
      case 'fail': return red('FAIL');
      case 'pending': return yellow('PEND');
      case 'skip': return dim('SKIP');
    }
  }

  private printLeg(leg: LegRecord): void {
    console.log('');
    console.log(`${this.badge(leg.status)}  ${bold(leg.name)}  ${dim(leg.ms + 'ms')}`);
    for (const ch of leg.checks) {
      const mark = ch.ok ? green('  ✓') : red('  ✗');
      console.log(`${mark} ${ch.desc}${ch.detail ? dim('  — ' + ch.detail) : ''}`);
    }
    if (leg.note) console.log(dim(`     ↳ ${leg.note}`));
  }

  // Returns true if the overall run is green (no fail). pending/skip are non-fatal.
  summary(): boolean {
    const counts = { pass: 0, fail: 0, pending: 0, skip: 0 } as Record<LegStatus, number>;
    let checksPass = 0, checksTotal = 0;
    for (const l of this.legs) {
      counts[l.status]++;
      for (const ch of l.checks) { checksTotal++; if (ch.ok) checksPass++; }
    }
    const overall = counts.fail === 0;
    console.log('');
    console.log(dim('─'.repeat(64)));
    console.log(
      bold('Summary  ') +
      `${green(counts.pass + ' pass')}, ` +
      `${counts.fail ? red(counts.fail + ' fail') : dim('0 fail')}, ` +
      `${counts.pending ? yellow(counts.pending + ' pending') : dim('0 pending')}, ` +
      `${dim(counts.skip + ' skip')}   ` +
      dim(`(${checksPass}/${checksTotal} checks)`),
    );
    console.log(
      bold('Overall  ') + (overall ? green('● GREEN — pipeline validated') : red('● RED — failures above')),
    );
    if (counts.pending) {
      console.log(dim('Pending legs are expected-degraded (e.g. live MiniMax cred pairing) — not failures.'));
    }
    console.log('');
    return overall;
  }
}
