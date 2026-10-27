import type { Coin } from './papertrade.ts';

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

/** What a strategy can see. Implemented by the live feed and by the backtest replay. */
export interface MarketView {
  now(): number;
  quote(coin: Coin): { bid: number; ask: number; mid: number } | undefined;
  /** 1-second mids, oldest → newest. May be shorter than requested right after start. */
  history(coin: Coin, seconds: number): Float64Array;
  /** 1-minute candles, oldest → newest; the last one may still be forming. */
  candles(coin: Coin, n: number): Candle[];
  /** Completed bars of a longer timeframe (15m, 1h, 4h, 1d), the same bars the research factory tests on. */
  bars?(coin: Coin, tf: string, n: number): Candle[];
}

/** Append-only float buffer that keeps the last `cap` values contiguous, so reads are zero-copy views. */
export class Series {
  private buf: Float64Array;
  private cap: number;
  private start = 0;
  private end = 0;
  constructor(cap: number) {
    this.cap = cap;
    this.buf = new Float64Array(cap * 2);
  }
  push(v: number): void {
    if (this.end === this.buf.length) {
      this.buf.copyWithin(0, this.end - this.cap, this.end);
      this.start = 0;
      this.end = this.cap;
    }
    this.buf[this.end++] = v;
    if (this.end - this.start > this.cap) this.start++;
  }
  last(n: number): Float64Array {
    return this.buf.subarray(Math.max(this.start, this.end - n), this.end);
  }
  get length(): number {
    return this.end - this.start;
  }
}

/** Builds 1m candles from a stream of mids. */
export class CandleBook {
  candles: Candle[] = [];
  private cap: number;
  constructor(cap = 6000) {
    this.cap = cap;
  }
  seed(cs: Candle[]): void {
    const last = this.candles.at(-1)?.t ?? 0;
    for (const c of cs) if (c.t > last) this.candles.push(c);
    this.trim();
  }
  update(t: number, px: number): void {
    const m = Math.floor(t / 60_000) * 60_000;
    const cur = this.candles.at(-1);
    if (cur && cur.t === m) {
      cur.h = Math.max(cur.h, px);
      cur.l = Math.min(cur.l, px);
      cur.c = px;
    } else if (!cur || m > cur.t) {
      this.candles.push({ t: m, o: px, h: px, l: px, c: px, v: 0 });
      this.trim();
    }
  }
  last(n: number): Candle[] {
    return this.candles.slice(-n);
  }
  private trim(): void {
    if (this.candles.length > this.cap) this.candles.splice(0, this.candles.length - this.cap);
  }
}

/** JSON with sorted keys, so {a,b} and {b,a} hash the same. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

type Arr = ArrayLike<number>;
const tail = (a: Arr, n: number) => Array.prototype.slice.call(a, Math.max(0, a.length - n)) as number[];

/** Indicator helpers exposed to strategies as ctx.ind. All take array-likes (oldest → newest). */
export const indicators = {
  sma(a: Arr, n: number): number {
    const t = tail(a, n);
    return t.length ? t.reduce((s, v) => s + v, 0) / t.length : NaN;
  },
  ema(a: Arr, n: number): number {
    if (!a.length) return NaN;
    const k = 2 / (n + 1);
    const from = Math.max(0, a.length - n * 4);
    let e = a[from];
    for (let i = from + 1; i < a.length; i++) e = a[i] * k + e * (1 - k);
    return e;
  },
  stdev(a: Arr, n: number): number {
    const t = tail(a, n);
    if (t.length < 2) return NaN;
    const m = t.reduce((s, v) => s + v, 0) / t.length;
    return Math.sqrt(t.reduce((s, v) => s + (v - m) ** 2, 0) / (t.length - 1));
  },
  zscore(a: Arr, n: number): number {
    const sd = indicators.stdev(a, n);
    return sd > 0 ? (a[a.length - 1] - indicators.sma(a, n)) / sd : 0;
  },
  rsi(a: Arr, n = 14): number {
    const t = tail(a, n + 1);
    let up = 0, down = 0;
    for (let i = 1; i < t.length; i++) {
      const d = t[i] - t[i - 1];
      if (d > 0) up += d; else down -= d;
    }
    if (up + down === 0) return 50;
    return 100 * up / (up + down);
  },
  /** Return over the last `lag` samples in bps. */
  returnBps(a: Arr, lag: number): number {
    if (a.length <= lag) return 0;
    const prev = a[a.length - 1 - lag];
    return (a[a.length - 1] / prev - 1) * 1e4;
  },
  /** Realized volatility per sample in bps over the last n samples. */
  volBps(a: Arr, n: number): number {
    const t = tail(a, n + 1);
    const r: number[] = [];
    for (let i = 1; i < t.length; i++) r.push((t[i] / t[i - 1] - 1) * 1e4);
    return indicators.stdev(r, r.length);
  },
  highest(a: Arr, n: number): number {
    return Math.max(...tail(a, n));
  },
  lowest(a: Arr, n: number): number {
    return Math.min(...tail(a, n));
  },
  /** Average true range of 1m candles, in bps of the last close. */
  atrBps(cs: Candle[], n = 14): number {
    const t = cs.slice(-(n + 1));
    if (t.length < 2) return NaN;
    let s = 0;
    for (let i = 1; i < t.length; i++) {
      s += Math.max(t[i].h - t[i].l, Math.abs(t[i].h - t[i - 1].c), Math.abs(t[i].l - t[i - 1].c));
    }
    return (s / (t.length - 1) / t[t.length - 1].c) * 1e4;
  },
};
