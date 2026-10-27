// Exact replica of Papertrade's settlement math (contract set 2, docs dated 2026-10-21).
// Source: https://docs.papertrade.xyz/how/asymmetric-impact/ and /learn/liquidations/
// All moves are fractions of entry price (1 bp = 0.0001).

/** Any asset symbol (Papertrade itself lists only BTC and ETH; Hyperliquid has many). */
export type Coin = string;
export type Side = 'long' | 'short';
/** Papertrade's markets. */
export const COINS: Coin[] = ['BTC', 'ETH'];

export const MAX_LEVERAGE = 1000;
export const MAX_NOTIONAL = 10_000_000;
export const DEADBAND = 1 / 50_000; // 0.2 bps
export const WIN_FEE = 0.02;
// Docs: "about 5 bps"; their worked 1000x example (liq after ~0.052% move) and the
// 100x example ($99.05 on a $100 entry) both fit 4.8 bps.
export const LIQ_BUFFER = 0.00048;

interface MarketParams { baseRate: number; rateMultiplier: number; referenceNotional: number; positionMultiplier: number }
export const MARKET: Record<string, MarketParams> = {
  BTC: { baseRate: 0.10, rateMultiplier: 15_000, referenceNotional: 100_000, positionMultiplier: 814.598 },
  ETH: { baseRate: 0.10, rateMultiplier: 15_000, referenceNotional: 100_000, positionMultiplier: 483.979 },
};

// Holdback bands in bps. Standard curve normally, off-hours curve on weekends/quiet hours.
const CURVES = {
  standard: { start: 0.75, end: 6, k: 3.597, pow: 2 },
  offHours: { start: 0.3, end: 10, k: 6.085, pow: 3 },
};

/** Holdback in bps for a raw favourable move given in bps. */
export function holdbackBps(moveBps: number, offHours: boolean): number {
  const c = offHours ? CURVES.offHours : CURVES.standard;
  if (moveBps <= c.start || moveBps >= c.end) return 0;
  const width = c.end - c.start;
  const u = (moveBps - c.start) / width;
  return c.k * width * u * u * (1 - u) ** c.pow;
}

/** Bust move: adverse fraction at which the keeper hard-liquidates (full margin lost). */
export function bustMove(leverage: number): number {
  return Math.max(1 / leverage - LIQ_BUFFER, 0);
}

export function bustPrice(side: Side, entry: number, leverage: number): number {
  const m = bustMove(leverage);
  return side === 'long' ? entry * (1 - m) : entry * (1 + m);
}

export interface Settlement {
  pnl: number;          // what the trader gets/loses (net of all fees)
  rawPnl: number;       // notional × raw price move, no fees
  feePaid: number;      // rawPnl - pnl on wins (deadband + holdback + impact + win fee)
  liquidated: boolean;
  moveBps: number;      // signed favourable move in bps
}

/** Settle a close at `exit`. A close at or past the bust price settles as a liquidation. */
export function settle(coin: Coin, side: Side, entry: number, exit: number, margin: number, leverage: number, offHours: boolean): Settlement {
  const notional = margin * leverage;
  const signed = (side === 'long' ? exit - entry : entry - exit) / entry;
  const rawPnl = notional * signed;
  const moveBps = signed * 1e4;
  if (signed <= -bustMove(leverage)) {
    return { pnl: -margin, rawPnl, feePaid: 0, liquidated: true, moveBps };
  }
  if (signed <= 0) {
    return { pnl: Math.max(rawPnl, -margin), rawPnl, feePaid: 0, liquidated: false, moveBps };
  }
  const p = MARKET[coin];
  const move = signed - DEADBAND - holdbackBps(moveBps, offHours) / 1e4;
  if (move <= 0) return { pnl: 0, rawPnl, feePaid: rawPnl, liquidated: false, moveBps };
  const term1 = 1 / (move * p.rateMultiplier);
  const term2 = p.referenceNotional / (1e6 * move * p.positionMultiplier);
  const scale = (1 - p.baseRate) / (1 + term1 + term2);
  const pnl = notional * move * scale * (1 - WIN_FEE);
  return { pnl, rawPnl, feePaid: rawPnl - pnl, liquidated: false, moveBps };
}

/** Share of the raw gain a winner keeps after every haircut, for a favourable move in bps. */
export function keepRatio(coin: Coin, moveBps: number, offHours = false): number {
  const s = settle(coin, 'long', 100_000, 100_000 * (1 + moveBps / 1e4), 1, 1, offHours);
  return s.rawPnl > 0 ? s.pnl / s.rawPnl : 0;
}

/** Off-hours payout curve schedule. The real schedule is set by a protocol keeper;
 *  we approximate with UTC weekends plus optional configured quiet hours. */
export function isOffHours(t: number, quietHoursUtc: number[] = []): boolean {
  const d = new Date(t);
  const day = d.getUTCDay();
  return day === 0 || day === 6 || quietHoursUtc.includes(d.getUTCHours());
}
