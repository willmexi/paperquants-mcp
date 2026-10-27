// Live Hyperliquid prices for the local engine: the same BBO mid Papertrade settles on. A lighter copy of the server's
// src/feed.ts with no database: 1-second mids for 6 hours in memory, 1m candles seeded from Hyperliquid, and
// longer bars (15m/1h/4h/1d) fetched on demand and cached.
import { EventEmitter } from 'node:events';
import { COINS, type Coin } from '../../core/papertrade.ts';
import { Series, CandleBook, type Candle, type MarketView } from '../../core/market.ts';

const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const INFO_URL = 'https://api.hyperliquid.xyz/info';
const HISTORY_SECONDS = 6 * 3600;
const TF_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };

interface Quote { bid: number; ask: number; mid: number; t: number }

export async function fetchCandles(coin: string, startTime: number, endTime: number, interval: string): Promise<Candle[]> {
  const r = await fetch(INFO_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } }), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`candleSnapshot ${coin} ${interval}: HTTP ${r.status}`);
  return ((await r.json()) as Array<Record<string, string | number>>).map((x) => ({ t: Number(x.t), o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v }));
}

export class LocalFeed extends EventEmitter implements MarketView {
  quotes = new Map<Coin, Quote>();
  connected = false;
  lastMessageAt = 0;
  private hist = new Map<Coin, Series>(COINS.map((c) => [c, new Series(HISTORY_SECONDS)]));
  private books = new Map<Coin, CandleBook>(COINS.map((c) => [c, new CandleBook()]));
  private barCache = new Map<string, { at: number; bars: Candle[] }>();
  private ws?: WebSocket;
  private timers: NodeJS.Timeout[] = [];

  async start(): Promise<void> {
    // Seed history in the background: the engine must answer Claude right away; live prices arrive within a second.
    void this.seed();
    this.connect();
    let lastSecond = 0;
    this.timers.push(setInterval(() => {
      const t = Date.now();
      const sec = Math.floor(t / 1000);
      if (sec === lastSecond) return;
      lastSecond = sec;
      for (const c of COINS) {
        const q = this.quotes.get(c);
        if (q) this.hist.get(c)!.push(q.mid);
      }
      this.emit('second', t);
    }, 250));
    this.timers.push(setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ method: 'ping' }));
      if (this.connected && Date.now() - this.lastMessageAt > 60_000) this.ws?.close();
    }, 30_000));
    this.timers.push(setInterval(() => { for (const c of COINS) void this.refreshBars(c); }, 5 * 60_000));
  }

  private async seed(): Promise<void> {
    const now = Date.now();
    await Promise.all(COINS.map(async (c) => {
      const cs = await fetchCandles(c, now - 5000 * 60_000, now, '1m').catch(() => []);
      this.books.get(c)!.seed(cs);
      // Pre-load the 1-minute closes as 1-second history so strategies have context (coarse but contiguous), unless
      // live seconds already arrived.
      const s = this.hist.get(c)!;
      if (!s.length) for (const k of cs.slice(-360)) for (let i = 0; i < 60; i++) s.push(k.c);
      await this.refreshBars(c);
    }));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.ws?.close();
  }

  private connect(): void {
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.lastMessageAt = Date.now();
      for (const coin of COINS) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'bbo', coin } }));
    };
    ws.onmessage = (e) => {
      this.lastMessageAt = Date.now();
      const m = JSON.parse(String(e.data));
      if (m.channel !== 'bbo') return;
      const coin = m.data.coin as Coin;
      const [b, a] = m.data.bbo ?? [];
      if (!b || !a) return;
      const bid = +b.px, ask = +a.px;
      if (!(bid > 0 && ask > bid)) return; // Papertrade's oracle reverts on zero/crossed books
      const t = Date.now();
      const q = { bid, ask, mid: (bid + ask) / 2, t };
      this.quotes.set(coin, q);
      this.books.get(coin)?.update(t, q.mid);
      this.emit('quote', coin, q);
    };
    ws.onclose = () => {
      this.connected = false;
      setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = () => ws.close();
  }

  private async refreshBars(coin: Coin): Promise<void> {
    const now = Date.now();
    for (const [tf, ms] of Object.entries(TF_MS)) {
      const bars = await fetchCandles(coin, now - 800 * ms, now, tf).catch(() => null);
      if (bars?.length) this.barCache.set(`${coin}:${tf}`, { at: now, bars: bars.filter((b) => b.t + ms <= now) });
    }
  }

  now(): number { return Date.now(); }
  quote(coin: Coin) { return this.quotes.get(coin); }
  history(coin: Coin, seconds: number): Float64Array { return this.hist.get(coin)?.last(seconds) ?? new Float64Array(); }
  candles(coin: Coin, n: number): Candle[] { return this.books.get(coin)?.last(n) ?? []; }
  bars(coin: Coin, tf: string, n: number): Candle[] { return this.barCache.get(`${coin}:${tf}`)?.bars.slice(-n) ?? []; }
}
