// The pure half of the risk desk: the pre-trade check and the owner's profile band, with no database or settings, so
// the local engine in the PaperQuants MCP package can bundle exactly the rules the server runs.
import { liqMove, type Venue } from './venues.ts';
import type { OrderCheck } from './sim.ts';

export interface RiskLimits {
  killSwitch: boolean;              // no new positions anywhere; open ones are closed when it's switched on
  maxMarginPctOfPortfolio: number;  // one position's margin vs its bot's whole portfolio (Will's A+ rule: 50)
  strategyDailyLossPct: number;     // a strategy down this much since the UTC day began is paused
  deskDailyLossPct: number;         // same for a desk (all of its bots together)
  firmDailyLossPct: number;         // same for the whole firm: halts all new positions
  maxNetMarginPctPerAsset: number;  // crowding: net long-minus-short margin on one asset vs firm equity
}

export const DEFAULT_LIMITS: RiskLimits = {
  killSwitch: false,
  maxMarginPctOfPortfolio: 50,
  strategyDailyLossPct: 70,
  deskDailyLossPct: 50,
  firmDailyLossPct: 35,
  maxNetMarginPctPerAsset: 40,
};

export interface RiskState {
  firmHalted?: string;
  pausedStrategies: Map<number, string>;
  pausedDesks: Map<string, string>;
}

export interface OrderContext {
  strategyId: number;
  desk?: string | null;
  portfolio?: number;                 // the bot's wallet + live equity, if the strategy belongs to a bot
  netMargin: (coin: string) => number; // firm-wide signed margin on the asset (long +, short −)
  firmEquity: number;
  maxLeverage?: number | null;        // the owner's risk profile cap (agents.max_leverage)
}

/** Pure pre-trade check. Returns why the order is refused, or undefined. */
export function checkOrder(o: OrderCheck, ctx: OrderContext, limits: RiskLimits, state: RiskState): string | undefined {
  if (limits.killSwitch) return 'kill switch is on';
  if (state.firmHalted) return `firm halted: ${state.firmHalted}`;
  const ps = state.pausedStrategies.get(ctx.strategyId);
  if (ps) return `strategy paused: ${ps}`;
  const pd = ctx.desk ? state.pausedDesks.get(ctx.desk) : undefined;
  if (pd) return `desk ${ctx.desk} paused: ${pd}`;
  if (ctx.maxLeverage && o.leverage > ctx.maxLeverage) return `the owner's risk profile caps leverage at ${ctx.maxLeverage}× (asked ${o.leverage}×)`;
  if (o.slBps != null) {
    const liqBps = liqMove(o.venue as Venue, o.coin, o.leverage) * 1e4;
    if (o.slBps >= liqBps) return `stop at ${o.slBps} bp is past liquidation (${liqBps.toFixed(1)} bp at ${o.leverage}×)`;
  }
  if (ctx.portfolio != null && ctx.portfolio > 0 && o.margin > (limits.maxMarginPctOfPortfolio / 100) * ctx.portfolio + 1e-9) {
    return `margin $${o.margin.toFixed(2)} is over ${limits.maxMarginPctOfPortfolio}% of the bot's $${ctx.portfolio.toFixed(2)} portfolio`;
  }
  if (ctx.firmEquity > 0) {
    const now = ctx.netMargin(o.coin);
    const next = now + (o.side === 'long' ? o.margin : -o.margin);
    const cap = (limits.maxNetMarginPctPerAsset / 100) * ctx.firmEquity;
    if (Math.abs(next) > cap && Math.abs(next) > Math.abs(now)) {
      return `the firm is already ${now >= 0 ? 'long' : 'short'} $${Math.abs(now).toFixed(0)} of ${o.coin} margin (cap $${cap.toFixed(0)}); crowding`;
    }
  }
  return undefined;
}

/** The owner's risk profile is a band, not only a cap: DEGEN trades 500–1000× on Papertrade (SOL/HYPE on Hyperliquid
 *  are exempt: that venue caps them far lower), and sizes each setup at 20–50% of the portfolio, so one order (one
 *  ladder leg) must be at least 6% of it. */
export function degenFloor(riskProfile: string | null | undefined, o: { venue?: string; leverage: number; margin?: number }, portfolio?: number): string | undefined {
  if (riskProfile !== 'DEGEN') return undefined;
  if ((o.venue ?? 'papertrade') === 'papertrade' && o.leverage < 500) return `the owner's DEGEN profile means 500–1000× on Papertrade (asked ${o.leverage}×)`;
  if (o.margin != null && portfolio != null && portfolio > 0 && o.margin < 0.06 * portfolio) return `the owner's DEGEN profile sizes each setup at 20–50% of the portfolio: one order must be at least 6% ($${(0.06 * portfolio).toFixed(0)}), asked $${o.margin.toFixed(0)}`;
  return undefined;
}
