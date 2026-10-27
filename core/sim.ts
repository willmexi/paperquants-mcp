import { isOffHours, type Coin, type Side } from './papertrade.ts';
import { settleVenue, liqMove, maxLeverage, maxNotional, fundingPayment, type Venue } from './venues.ts';

export const PT_MIN_MARGIN = 10;
export const PT_MIN_NOTIONAL = 500;
export const MIN_MARGIN = 1;
const MAX_OPEN_POSITIONS = 20;

export interface OpenAction {
  action: 'open';
  coin: Coin;
  venue?: Venue;       // default papertrade
  side: Side;
  margin?: number;     // USDC
  marginPct?: number;  // % of available balance (alternative to margin)
  leverage: number;
  tpBps?: number;      // engine-side take profit (fires a close, which fills after latency)
  slBps?: number;      // engine-side stop loss
  maxHoldSec?: number;
  tag?: string;
}
export interface CloseAction { action: 'close'; id: number }
export interface CloseAllAction { action: 'closeAll'; coin?: Coin }
/** Move a live position's engine-side exits. 0 clears one; omitted leaves it as it is. */
export interface ModifyAction { action: 'modify'; id: number; tpBps?: number; slBps?: number; maxHoldSec?: number }
export type Action = OpenAction | CloseAction | CloseAllAction | ModifyAction;

export interface Position {
  id: number;
  coin: Coin;
  venue?: Venue;       // undefined = papertrade (older snapshots)
  funding?: number;    // funding paid so far (negative = received); Hyperliquid only
  side: Side;
  margin: number;
  leverage: number;
  entry: number;
  openedAt: number;
  tpBps?: number;
  slBps?: number;
  maxHoldSec?: number;
  tag?: string;
  closing?: 'close' | 'tp' | 'sl' | 'time';
}

/** What the risk gate sees for every new order, after sizing. Returns a reason to reject, or nothing. */
export interface OrderCheck { coin: Coin; venue: Venue; side: Side; leverage: number; margin: number; slBps?: number }
export type RiskGate = (o: OrderCheck) => string | undefined;

export interface ClosedTrade extends Position {
  exit: number;
  closedAt: number;
  reason: 'close' | 'tp' | 'sl' | 'time' | 'liquidated';
  pnl: number;
  rawPnl: number;
  feePaid: number;
  moveBps: number;
  offHours: boolean;
}

interface Pending { due: number; kind: 'open'; coin: Coin; order: Required<Pick<OpenAction, 'side' | 'leverage'>> & OpenAction & { margin: number } }
interface PendingClose { due: number; kind: 'close'; coin: Coin; id: number }

export interface Stats {
  trades: number;
  wins: number;
  losses: number;
  liquidations: number;
  grossWin: number;
  grossLoss: number;
  feesPaid: number;
  volume: number;
  peakEquity: number;
  maxDrawdownPct: number;
  realizedPnl: number;
  bestTrade: number;
  worstTrade: number;
}

export interface AccountSnapshot {
  balance: number;
  positions: Position[];
  stats: Stats;
  nextId: number;
  state: unknown;
}

export const emptyStats = (start: number): Stats => ({
  trades: 0, wins: 0, losses: 0, liquidations: 0, grossWin: 0, grossLoss: 0, feesPaid: 0, volume: 0,
  peakEquity: start, maxDrawdownPct: 0, realizedPnl: 0, bestTrade: 0, worstTrade: 0,
});

/** Derived numbers shown on the leaderboard and fed back to agents. */
export function summarize(stats: Stats, equity: number, start: number, extra: Record<string, unknown> = {}) {
  const pnl = equity - start;
  return {
    ...stats,
    equity,
    pnl,
    pnlPct: (pnl / start) * 100,
    winRate: stats.trades ? (stats.wins / stats.trades) * 100 : 0,
    avgWin: stats.wins ? stats.grossWin / stats.wins : 0,
    avgLoss: stats.losses ? stats.grossLoss / stats.losses : 0,
    profitFactor: stats.grossLoss > 0 ? stats.grossWin / stats.grossLoss : stats.grossWin > 0 ? Infinity : 0,
    ...extra,
  };
}

/** One strategy's isolated Papertrade account: $1000 of paper USDC, positions settled at BBO mid. */
export class Account {
  balance: number;
  positions: Position[] = [];
  stats: Stats;
  nextId = 1;
  rejected: string[] = [];
  /** Set by the arena: every open passes the firm's risk engine (risk.ts) before it takes margin. */
  guard?: RiskGate;
  private pending: Array<Pending | PendingClose> = [];
  private latencyMs: number;
  private quietHours: number[];

  constructor(startBalance: number, latencyMs: number, quietHours: number[] = [], snap?: AccountSnapshot) {
    this.latencyMs = latencyMs;
    this.quietHours = quietHours;
    this.balance = snap?.balance ?? startBalance;
    this.positions = snap?.positions.map((p) => ({ ...p, closing: undefined })) ?? [];
    this.stats = snap?.stats ?? emptyStats(startBalance);
    this.nextId = snap?.nextId ?? 1;
  }

  snapshot(state: unknown): AccountSnapshot {
    // Pending opens are refunded in a snapshot: after a restart they would never fill.
    const reserved = this.pending.reduce((s, p) => s + (p.kind === 'open' ? p.order.margin : 0), 0);
    return { balance: this.balance + reserved, positions: this.positions, stats: this.stats, nextId: this.nextId, state };
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Mark-to-market equity: balance + what every position would return if closed now (net of fees). */
  equity(mid: (c: Coin) => number | undefined, t: number): number {
    const off = isOffHours(t, this.quietHours);
    let eq = this.balance;
    for (const p of this.pending) if (p.kind === 'open') eq += p.order.margin;
    for (const p of this.positions) {
      const px = mid(p.coin);
      eq += px ? p.margin + settleOf(p, px, off).pnl : p.margin;
    }
    return eq;
  }

  isBusted(): boolean {
    return this.balance < MIN_MARGIN && this.positions.length === 0 && this.pending.length === 0;
  }

  /** Queue actions. Opens reserve margin now and fill at the mid `latencyMs` later. */
  submit(actions: Action[], t: number): void {
    this.rejected = [];
    for (const a of actions.slice(0, 10)) {
      if (!a || typeof a !== 'object') continue;
      if (a.action === 'close') {
        const p = this.positions.find((x) => x.id === a.id);
        if (p) this.requestClose(p, 'close', t);
      } else if (a.action === 'modify') {
        const p = this.positions.find((x) => x.id === a.id);
        if (!p) this.rejected.push(`no open position #${a.id}`);
        else if (p.closing) this.rejected.push(`position #${a.id} is already closing`);
        else {
          if (a.tpBps !== undefined) p.tpBps = num(a.tpBps);
          // A negative stop sits past entry, in profit (a trailing stop); 0 or null removes it.
          if (a.slBps !== undefined) p.slBps = a.slBps === null || Number(a.slBps) === 0 || !Number.isFinite(Number(a.slBps)) ? undefined : Number(a.slBps);
          if (a.maxHoldSec !== undefined) p.maxHoldSec = num(a.maxHoldSec);
        }
      } else if (a.action === 'closeAll') {
        for (const p of this.positions) if (!a.coin || p.coin === a.coin) this.requestClose(p, 'close', t);
      } else if (a.action === 'open') {
        const err = this.queueOpen(a, t);
        if (err) this.rejected.push(err);
      }
    }
  }

  private queueOpen(a: OpenAction, t: number): string | undefined {
    const venue: Venue = a.venue ?? 'papertrade';
    const maxLev = maxLeverage(venue, a.coin);
    if (!maxLev) return `${a.coin} is not tradable on ${venue}`;
    if (a.side !== 'long' && a.side !== 'short') return `bad side ${a.side}`;
    const leverage = Number(a.leverage);
    if (!(leverage >= 1 && leverage <= maxLev)) return `leverage on ${venue} ${a.coin} must be 1..${maxLev}`;
    let margin = a.margin != null ? Number(a.margin) : (Number(a.marginPct) / 100) * this.balance;
    if (!Number.isFinite(margin)) return 'margin or marginPct required';
    margin = Math.min(margin, this.balance, maxNotional(venue) / leverage);
    if (margin < MIN_MARGIN) return `margin below $${MIN_MARGIN} (balance ${this.balance.toFixed(2)})`;
    // Papertrade's own minimums (GET /state/trading, 2026-10-27): margin ≥ $10 and position value (margin × leverage) ≥ $500.
    if (venue === 'papertrade' && margin < PT_MIN_MARGIN) return `Papertrade minimum margin is $${PT_MIN_MARGIN} per trade (asked $${margin.toFixed(2)})`;
    if (venue === 'papertrade' && margin * leverage < PT_MIN_NOTIONAL) return `Papertrade minimum position value is $${PT_MIN_NOTIONAL} (margin × leverage; asked $${(margin * leverage).toFixed(0)})`;
    const openCount = this.positions.length + this.pending.filter((p) => p.kind === 'open').length;
    if (openCount >= MAX_OPEN_POSITIONS) return `max ${MAX_OPEN_POSITIONS} open positions`;
    const veto = this.guard?.({ coin: a.coin, venue, side: a.side, leverage, margin, slBps: num(a.slBps) });
    if (veto) return `risk: ${veto}`;
    this.balance -= margin;
    this.pending.push({ due: t + this.latencyMs, kind: 'open', coin: a.coin, order: { ...a, venue, leverage, margin } });
    return undefined;
  }

  private requestClose(p: Position, reason: NonNullable<Position['closing']>, t: number): void {
    if (p.closing) return;
    p.closing = reason;
    this.pending.push({ due: t + this.latencyMs, kind: 'close', coin: p.coin, id: p.id });
  }

  /** Feed a new mid for `coin`. Returns trades closed by this update. */
  onPrice(coin: Coin, mid: number, t: number): ClosedTrade[] {
    const closed: ClosedTrade[] = [];
    const off = isOffHours(t, this.quietHours);

    // Fill due orders for this coin at the current mid.
    if (this.pending.length) {
      const due = this.pending.filter((p) => p.coin === coin && p.due <= t);
      if (due.length) {
        this.pending = this.pending.filter((p) => !due.includes(p));
        for (const d of due) {
          if (d.kind === 'open') {
            const o = d.order;
            this.positions.push({
              id: this.nextId++, coin, venue: o.venue === 'hyperliquid' ? 'hyperliquid' : undefined, side: o.side, margin: o.margin, leverage: o.leverage, entry: mid, openedAt: t,
              tpBps: num(o.tpBps), slBps: num(o.slBps), maxHoldSec: num(o.maxHoldSec), tag: o.tag ? String(o.tag).slice(0, 40) : undefined,
            });
            this.stats.volume += o.margin * o.leverage;
          } else {
            const p = this.positions.find((x) => x.id === d.id);
            if (p) closed.push(this.close(p, mid, t, p.closing ?? 'close', off));
          }
        }
      }
    }

    for (const p of this.positions) {
      if (p.coin !== coin) continue;
      const fav = (p.side === 'long' ? mid - p.entry : p.entry - mid) / p.entry;
      // The keeper liquidates as soon as BBO mid crosses the bust price, ahead of any pending close.
      if (fav <= -liqMove(p.venue ?? 'papertrade', p.coin, p.leverage, p.funding ?? 0, p.margin)) {
        closed.push(this.close(p, mid, t, 'liquidated', off));
        continue;
      }
      if (p.closing) continue;
      const bps = fav * 1e4;
      if (p.tpBps != null && bps >= p.tpBps) this.requestClose(p, 'tp', t);
      else if (p.slBps != null && bps <= -p.slBps) this.requestClose(p, 'sl', t);
      else if (p.maxHoldSec != null && t - p.openedAt >= p.maxHoldSec * 1000) this.requestClose(p, 'time', t);
    }
    if (closed.length) {
      const ids = new Set(closed.map((c) => c.id));
      this.positions = this.positions.filter((p) => !ids.has(p.id));
      this.pending = this.pending.filter((p) => p.kind !== 'close' || !ids.has(p.id));
    }
    return closed;
  }

  /** Close every position right now (strategy shutdown): ignores pending closes and latency. With no quote the
   *  position settles flat at entry, so its margin is never lost. Pending opens are refunded. */
  closeAllNow(mid: (c: Coin) => number | undefined, t: number): ClosedTrade[] {
    const off = isOffHours(t, this.quietHours);
    const closed = this.positions.map((p) => this.close(p, mid(p.coin) ?? p.entry, t, p.closing ?? 'close', off));
    this.positions = [];
    for (const d of this.pending) if (d.kind === 'open') this.balance += d.order.margin;
    this.pending = [];
    return closed;
  }

  private close(p: Position, exit: number, t: number, reason: ClosedTrade['reason'], off: boolean): ClosedTrade {
    const s = settleOf(p, exit, off);
    const r = s.liquidated ? 'liquidated' : reason;
    this.balance += p.margin + s.pnl;
    const st = this.stats;
    st.trades++;
    st.realizedPnl += s.pnl;
    st.feesPaid += s.feePaid;
    if (s.pnl > 0) { st.wins++; st.grossWin += s.pnl; } else { st.losses++; st.grossLoss -= s.pnl; }
    if (r === 'liquidated') st.liquidations++;
    st.bestTrade = Math.max(st.bestTrade, s.pnl);
    st.worstTrade = Math.min(st.worstTrade, s.pnl);
    return { ...p, exit, closedAt: t, reason: r, pnl: s.pnl, rawPnl: s.rawPnl, feePaid: s.feePaid, moveBps: s.moveBps, offHours: off };
  }

  /** Hourly funding on Hyperliquid positions in `coin` at the current hourly rate. Returns the total paid. */
  applyFunding(coin: Coin, hourlyRate: number, mid: number): number {
    let paid = 0;
    for (const p of this.positions) {
      if (p.venue !== 'hyperliquid' || p.coin !== coin) continue;
      const pay = fundingPayment(p.side, p.margin * p.leverage * (mid / p.entry), hourlyRate);
      p.funding = (p.funding ?? 0) + pay;
      paid += pay;
    }
    return paid;
  }

  /** Update peak/drawdown from a mark-to-market equity sample. */
  markEquity(eq: number): void {
    const st = this.stats;
    st.peakEquity = Math.max(st.peakEquity, eq);
    if (st.peakEquity > 0) st.maxDrawdownPct = Math.max(st.maxDrawdownPct, ((st.peakEquity - eq) / st.peakEquity) * 100);
  }
}

function settleOf(p: Position, exit: number, off: boolean) {
  return settleVenue(p.venue ?? 'papertrade', p.coin, p.side, p.entry, exit, p.margin, p.leverage, off, p.funding ?? 0);
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? n : undefined;
}
