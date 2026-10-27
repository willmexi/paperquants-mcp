import vm from 'node:vm';
import { COINS, isOffHours, settle, bustPrice, type Coin, type Side } from './papertrade.ts';
import { posLiqPrice, posSettle } from './venues.ts';
import { indicators, type MarketView } from './market.ts';
import type { Account, Action } from './sim.ts';

const TICK_TIMEOUT_MS = 50;
const MAX_CONSECUTIVE_ERRORS = 30;

/**
 * Runs one strategy's code in a separate V8 context with a per-tick timeout.
 * node:vm is isolation against accidents (runaway loops, stray globals), not a security
 * boundary; strategies are written by the frontier models we configure, not by strangers.
 */
export class StrategyRuntime {
  state: Record<string, unknown>;
  errors = 0;
  consecutiveErrors = 0;
  lastError?: string;
  logs: string[] = [];
  private context: vm.Context;
  private tickScript = new vm.Script('__out = onTick(__ctx)');
  private hasInit: boolean;
  private initialised = false;
  private quietHours: number[];
  private coins: () => readonly string[];

  /** `coins` lists the markets the strategy sees (the server passes its live asset list; default BTC/ETH). */
  constructor(code: string, params: Record<string, unknown>, quietHours: number[], state?: Record<string, unknown>, coins: () => readonly string[] = () => COINS) {
    this.quietHours = quietHours;
    this.coins = coins;
    this.state = state ?? {};
    const logs = this.logs;
    this.context = vm.createContext(
      {
        params: Object.freeze(structuredClone(params ?? {})),
        console: { log: (...a: unknown[]) => { logs.push(a.map(String).join(' ').slice(0, 300)); if (logs.length > 50) logs.shift(); } },
      },
      { codeGeneration: { strings: false, wasm: false } },
    );
    new vm.Script(code, { filename: 'strategy.js' }).runInContext(this.context, { timeout: 500 });
    if (typeof this.context.onTick !== 'function') throw new Error('strategy must define function onTick(ctx)');
    this.hasInit = typeof this.context.init === 'function';
  }

  get disabled(): boolean {
    return this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;
  }

  /** Run one decision tick. Returns the actions the strategy asked for (never throws). */
  tick(view: MarketView, account: Account): Action[] {
    const ctx = buildCtx(view, account, this.state, this.quietHours, this.coins());
    try {
      if (this.hasInit && !this.initialised) {
        this.context.__ctx = ctx;
        new vm.Script('init(__ctx)').runInContext(this.context, { timeout: 500 });
      }
      this.initialised = true;
      this.context.__ctx = ctx;
      this.tickScript.runInContext(this.context, { timeout: TICK_TIMEOUT_MS });
      this.consecutiveErrors = 0;
      return normalise(this.context.__out);
    } catch (e) {
      this.errors++;
      this.consecutiveErrors++;
      this.lastError = (e as Error).message?.slice(0, 300) ?? String(e);
      return [];
    }
  }
}

function normalise(out: unknown): Action[] {
  if (!out) return [];
  const list = Array.isArray(out) ? out : [out];
  // Copy into host-realm plain objects so nothing from the strategy context leaks into the engine.
  return JSON.parse(JSON.stringify(list.slice(0, 10)));
}

export function buildCtx(view: MarketView, account: Account, state: Record<string, unknown>, quietHours: number[], coins: readonly string[] = COINS) {
  const t = view.now();
  const off = isOffHours(t, quietHours);
  const mids: Partial<Record<Coin, number>> = {};
  const markets: Record<string, { bid: number; ask: number; mid: number; spreadBps: number }> = {};
  for (const c of coins as Coin[]) {
    const qt = view.quote(c);
    if (!qt) continue;
    mids[c] = qt.mid;
    markets[c] = { bid: qt.bid, ask: qt.ask, mid: qt.mid, spreadBps: ((qt.ask - qt.bid) / qt.mid) * 1e4 };
  }
  return {
    now: t,
    offHours: off,
    markets,
    balance: account.balance,
    equity: account.equity((c) => mids[c], t),
    pendingOrders: account.pendingCount,
    positions: account.positions.map((p) => {
      const px = mids[p.coin] ?? p.entry;
      const moveBps = ((p.side === 'long' ? px - p.entry : p.entry - px) / p.entry) * 1e4;
      return {
        id: p.id, coin: p.coin, side: p.side, margin: p.margin, leverage: p.leverage, entry: p.entry,
        openedAt: p.openedAt, ageSec: (t - p.openedAt) / 1000, moveBps, tag: p.tag, closing: !!p.closing,
        bustPrice: posLiqPrice(p),
        pnlIfClosed: posSettle(p, px, off).pnl,
      };
    }),
    state,
    // Copy, so one strategy can't scribble over the shared price buffer.
    history: (coin: Coin, seconds: number) => view.history(coin, Math.min(Math.max(1, seconds | 0), 6 * 3600)).slice(),
    candles: (coin: Coin, n: number) => view.candles(coin, Math.min(Math.max(1, n | 0), 5000)).map((c) => ({ ...c })),
    /** Completed 15m / 1h / 4h / 1d bars (null in backtests that only replay seconds). */
    bars: view.bars ? (coin: Coin, tf: string, n: number) => view.bars!(coin, tf, Math.min(Math.max(1, n | 0), 800)).map((c) => ({ ...c })) : null,
    ind: indicators,
    /** Net USDC a close would pay for a hypothetical favourable/adverse move. */
    payout: (coin: Coin, side: Side, moveBps: number, margin: number, leverage: number) =>
      settle(coin, side, 1, side === 'long' ? 1 + moveBps / 1e4 : 1 - moveBps / 1e4, margin, leverage, off).pnl,
  };
}
