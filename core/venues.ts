// Venues a position can trade on. Papertrade: synthetic 1–1000× BTC/ETH with its payout curve (papertrade.ts).
// Hyperliquid: the real perp exchange, linear PnL, taker fees, hourly funding and maintenance-margin liquidation.
// All paper for now; the models are what a real fill would cost.
import { settle as settlePapertrade, bustMove, MAX_LEVERAGE as PT_MAX_LEVERAGE, COINS as PT_COINS, type Settlement, type Side } from './papertrade.ts';

export type Venue = 'papertrade' | 'hyperliquid';
export const VENUES: Venue[] = ['papertrade', 'hyperliquid'];

/** Hyperliquid base-tier fees (fraction of notional per side). Market orders pay taker. */
export const HL_TAKER_FEE = 0.00045;
export const HL_MAKER_FEE = 0.00015;
export const HL_MAX_NOTIONAL = 10_000_000;

/** Per-asset Hyperliquid limits, loaded from the exchange's meta at startup (assets.ts). Defaults keep tests offline. */
const hlMaxLeverage = new Map<string, number>([['BTC', 40], ['ETH', 25], ['SOL', 20], ['XRP', 20], ['HYPE', 10]]);
export function setHyperliquidLimits(limits: Record<string, number>): void {
  for (const [coin, lev] of Object.entries(limits)) hlMaxLeverage.set(coin, lev);
}
export function hyperliquidLimits(): Record<string, number> {
  return Object.fromEntries(hlMaxLeverage);
}

export function venueAssets(venue: Venue): string[] {
  return venue === 'papertrade' ? [...PT_COINS] : [...hlMaxLeverage.keys()];
}

export function maxLeverage(venue: Venue, coin: string): number {
  if (venue === 'papertrade') return PT_COINS.includes(coin) ? PT_MAX_LEVERAGE : 0;
  return hlMaxLeverage.get(coin) ?? 0;
}

export function maxNotional(venue: Venue): number {
  return venue === 'papertrade' ? 10_000_000 : HL_MAX_NOTIONAL;
}

/** Maintenance margin as a fraction of notional: half the initial margin at the asset's max leverage. */
export function maintenanceFraction(coin: string): number {
  return 1 / (2 * (hlMaxLeverage.get(coin) ?? 20));
}

/**
 * Adverse move (fraction of entry) at which the position is liquidated.
 * Papertrade: hard bust at 1/leverage − 4.8 bp. Hyperliquid (isolated): when equity falls to maintenance margin,
 * margin − N·m = mmf·N·(1 − m)  ⇒  m = (1/lev − mmf) / (1 − mmf). Funding already paid eats into the margin.
 */
export function liqMove(venue: Venue, coin: string, leverage: number, fundingPaid = 0, margin = 1): number {
  if (venue === 'papertrade') return bustMove(leverage);
  const mmf = maintenanceFraction(coin);
  const lev = leverage / Math.max(1 - fundingPaid / margin, 1e-9); // funding paid shrinks the effective margin
  return Math.max((1 / lev - mmf) / (1 - mmf), 0);
}

/**
 * Settle a close. `fundingPaid` is the funding the position has paid (positive) or received (negative) while open.
 * Hyperliquid liquidation loses the whole isolated margin (conservative: the exchange keeps any remainder).
 */
export function settleVenue(venue: Venue, coin: string, side: Side, entry: number, exit: number, margin: number, leverage: number,
  offHours: boolean, fundingPaid = 0): Settlement {
  if (venue === 'papertrade') return settlePapertrade(coin, side, entry, exit, margin, leverage, offHours);
  const notional = margin * leverage;
  const signed = (side === 'long' ? exit - entry : entry - exit) / entry;
  const rawPnl = notional * signed;
  const moveBps = signed * 1e4;
  if (signed <= -liqMove(venue, coin, leverage, fundingPaid, margin)) {
    return { pnl: -margin, rawPnl, feePaid: 0, liquidated: true, moveBps };
  }
  const fees = HL_TAKER_FEE * (notional + notional * (exit / entry));
  const pnl = Math.max(rawPnl - fees - fundingPaid, -margin);
  return { pnl, rawPnl, feePaid: fees + fundingPaid, liquidated: false, moveBps };
}

/** Funding for one hourly payment: longs pay a positive rate, shorts receive it (and vice versa). */
export function fundingPayment(side: Side, notionalAtMark: number, hourlyRate: number): number {
  return (side === 'long' ? 1 : -1) * notionalAtMark * hourlyRate;
}

/** The bits of a position the venue math needs (sim.ts Position satisfies it). */
interface PositionLike { venue?: Venue; coin: string; side: Side; entry: number; margin: number; leverage: number; funding?: number }

/** Adverse move to liquidation for an open position, on its own venue. */
export function posLiqMove(p: PositionLike): number {
  return liqMove(p.venue ?? 'papertrade', p.coin, p.leverage, p.funding ?? 0, p.margin);
}

export function posLiqPrice(p: PositionLike): number {
  const m = posLiqMove(p);
  return p.side === 'long' ? p.entry * (1 - m) : p.entry * (1 + m);
}

/** What closing the position at `px` would settle to, fees and funding included. */
export function posSettle(p: PositionLike, px: number, offHours: boolean): Settlement {
  return settleVenue(p.venue ?? 'papertrade', p.coin, p.side, p.entry, px, p.margin, p.leverage, offHours, p.funding ?? 0);
}
