// The local engine: runs each agent's strategy every second on live Hyperliquid prices (paper account = the brain,
// same loop as the server's arena), mirrors its positions to the user's own Papertrade account with the local session
// key, and enforces the limits the user agreed to. Papertrade has no TP/SL orders, so this loop IS the exit: it keeps
// the machine awake while real positions are open.
import { spawn, type ChildProcess } from 'node:child_process';
import { setPriority as osSetPriority } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { Account, summarize, PT_MIN_MARGIN, PT_MIN_NOTIONAL, type AccountSnapshot, type ClosedTrade } from '../../core/sim.ts';
import { StrategyRuntime } from '../../core/sandbox.ts';
import { checkOrder, degenFloor, DEFAULT_LIMITS } from '../../core/riskCore.ts';
import { rawToUsd, type LivePosition } from '../../core/live/papertrade.ts';
import { COINS, type Coin } from '../../core/papertrade.ts';
import { LocalFeed } from './feed.ts';
import { PapertradeAdapter, findWallet, loadWallets, updateWallet, registerLocalKey, signLinkLocal, type VenueAdapter } from './adapter.ts';
import { readJson, writeJson } from '../home.ts';
import { api, session, netConfig } from '../net.ts';

export interface Limits {
  maxLeverage: number;          // 1..1000
  capitalUsd: number;           // the most of the account this agent may trade with
  maxMarginPctPerTrade: number; // one position's margin vs the agent's equity, 1..50
  maxDailyLossPct: number;      // agent pauses and closes everything past this loss in a UTC day
  coins: Coin[];                // BTC and/or ETH
  riskProfile?: 'DEGEN' | null; // DEGEN: 500×+ and each order ≥6% of equity
}

type MirrorStatus = 'opening' | 'open' | 'closing' | 'closed' | 'failed';
interface Mirror { simId: number; coin: string; side: 'long' | 'short'; leverage: number; marginUsd: number; intentId?: string; positionId?: string; entry?: number; status: MirrorStatus; openedAt: number; closedAt?: number; pnlUsd?: number; error?: string }

export interface AgentRecord {
  id: string; netId?: number; mode?: 'demo' | 'live'; wallet: string; name: string; thesis: string; code: string; params: Record<string, unknown>; limits: Limits;
  status: 'running' | 'paused' | 'stopped'; pausedReason?: string; createdAt: number; model?: string;
  realEquity: number; day: { date: string; start: number }; account?: AccountSnapshot; mirrors: Mirror[]; log: string[];
  recent?: Array<{ openedAt: number; closedAt: number; coin: string; side: string; lev: number; entry: number; exit: number; pnl: number; bps: number; reason: string }>;
  curve?: number[]; // equity every 5 minutes (last 2 days), shown on the website
  settings?: AgentSettings;
}

/** What the user chose beyond limits: a goal to hit, their own rules in words, and how often their AI checks in. */
export interface AgentSettings { goal?: { startUsd: number; targetUsd: number; days: number }; rules?: string; checkinMinutes?: number }
interface Live { rec: AgentRecord; runtime: StrategyRuntime; account: Account; venue: VenueAdapter | null; lastRejected?: string }
const isDemo = (r: AgentRecord) => r.mode === 'demo' || !r.wallet;
interface Snap { at: number; balanceUsd: number; availableUsd: number; positions: LivePosition[] }

const today = () => new Date().toISOString().slice(0, 10);
const MIRROR_WINDOW_MS = 10_000;

export function validateLimits(l: Partial<Limits>): Limits {
  const coins = (l.coins ?? []).map((c) => String(c).toUpperCase()).filter((c): c is Coin => (COINS as readonly string[]).includes(c));
  const num = (v: unknown, lo: number, hi: number, name: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`limit ${name} must be between ${lo} and ${hi}`);
    return n;
  };
  if (!coins.length) throw new Error('limit coins must include BTC and/or ETH');
  return {
    maxLeverage: Math.round(num(l.maxLeverage, 1, 1000, 'maxLeverage')),
    capitalUsd: num(l.capitalUsd, 1, 1_000_000, 'capitalUsd'),
    maxMarginPctPerTrade: num(l.maxMarginPctPerTrade, 1, 50, 'maxMarginPctPerTrade'),
    maxDailyLossPct: num(l.maxDailyLossPct, 1, 100, 'maxDailyLossPct'),
    coins,
    riskProfile: l.riskProfile === 'DEGEN' ? 'DEGEN' : null,
  };
}

function cleanSettings(s: AgentSettings | undefined, capital: number): AgentSettings {
  const out: AgentSettings = {};
  if (s?.goal && Number(s.goal.targetUsd) > 0 && Number(s.goal.days) > 0) out.goal = { startUsd: Number(s.goal.startUsd) || capital, targetUsd: Number(s.goal.targetUsd), days: Math.min(Math.max(Number(s.goal.days), 1), 365) };
  if (s?.rules) out.rules = String(s.rules).slice(0, 2000);
  if (s?.checkinMinutes) out.checkinMinutes = Math.min(Math.max(Math.round(Number(s.checkinMinutes)), 5), 1440);
  return out;
}

export class Engine {
  feed = new LocalFeed();
  live = new Map<string, Live>();
  killSwitch = readJson<{ on: boolean }>('kill.json', { on: false }).on;
  snaps = new Map<string, Snap>(); // per wallet (one agent per wallet)
  private lastKeyTry = new Map<string, number>();
  private awake?: ChildProcess;
  private timers: NodeJS.Timeout[] = [];

  async start(): Promise<void> {
    this.applyPriority();
    await this.feed.start();
    for (const rec of readJson<AgentRecord[]>('agents.json', [])) {
      try { this.instantiate(rec); } catch (e) { rec.status = 'stopped'; rec.pausedReason = `failed to load: ${(e as Error).message}`; this.instantiate(rec, true); }
    }
    this.feed.on('quote', (coin: Coin, q: { mid: number; t: number }) => {
      for (const a of this.live.values()) if (a.rec.status === 'running') this.closed(a, a.account.onPrice(coin, q.mid, q.t));
    });
    this.feed.on('second', (t: number) => this.onSecond(t));
    this.timers.push(setInterval(() => void this.reconcile().catch((e) => this.note(null, `reconcile: ${(e as Error).message}`)), 5000));
    this.timers.push(setInterval(() => this.persist(), 10_000));
    this.timers.push(setInterval(() => void this.heartbeat(), 60_000));
  }

  stop(): void {
    this.persist();
    this.timers.forEach(clearInterval);
    this.feed.stop();
    this.awake?.kill();
  }

  private instantiate(rec: AgentRecord, inert = false): Live {
    const runtime = inert ? new StrategyRuntime('function onTick(){}', {}, []) : new StrategyRuntime(rec.code, rec.params, [], (rec.account?.state as Record<string, unknown>) ?? undefined, () => rec.limits.coins);
    const account = new Account(rec.limits.capitalUsd, 1000, [], rec.account);
    account.guard = (o) => this.guard(rec, account, o);
    const l = { rec, runtime, account, venue: isDemo(rec) ? null : new PapertradeAdapter(rec.wallet) };
    this.live.set(rec.id, l);
    return l;
  }

  /** Every paper order passes the user's limits first; a refused order never reaches Papertrade. */
  private guard(rec: AgentRecord, account: Account, o: { coin: string; venue: string; side: string; leverage: number; margin: number; slBps?: number }): string | undefined {
    if (this.killSwitch) return 'kill switch is on';
    if (rec.status !== 'running') return `agent is ${rec.status}`;
    if (o.venue !== 'papertrade') return 'this engine trades Papertrade only';
    if (!(rec.limits.coins as string[]).includes(o.coin)) return `${o.coin} is outside this agent's limits (${rec.limits.coins.join(', ')})`;
    if (o.leverage > rec.limits.maxLeverage) return `leverage ${o.leverage}× is over the agreed max ${rec.limits.maxLeverage}×`;
    const eq = account.equity((c) => this.feed.quote(c)?.mid, Date.now());
    return checkOrder(o as never, { strategyId: 0, portfolio: eq, netMargin: () => 0, firmEquity: 0, maxLeverage: rec.limits.maxLeverage },
      { ...DEFAULT_LIMITS, maxMarginPctOfPortfolio: rec.limits.maxMarginPctPerTrade }, { pausedStrategies: new Map(), pausedDesks: new Map() })
      ?? degenFloor(rec.limits.riskProfile, o, eq);
  }

  private onSecond(t: number): void {
    for (const a of this.live.values()) {
      if (a.rec.status !== 'running') continue;
      for (const c of a.rec.limits.coins) {
        const q = this.feed.quote(c);
        if (q) this.closed(a, a.account.onPrice(c, q.mid, t));
      }
      const actions = a.runtime.tick(this.feed, a.account);
      if (actions.length) {
        a.account.submit(actions, t);
        // Surface refused orders (limits, liquidation-distance stops) once per distinct reason, so Claude sees them.
        const why = a.account.rejected[0];
        if (why && why !== a.lastRejected) { a.lastRejected = why; this.note(a, `order refused: ${why}`); }
      }
      if (a.runtime.disabled) this.pause(a, `strategy errored ${a.runtime.consecutiveErrors} times in a row: ${a.runtime.lastError}`);
      this.dailyLossCheck(a);
      this.syncMirrors(a);
    }
    this.keepAwake();
  }

  /** Paper opens become real opens within ~1s; paper exits (TP/SL/time) become real closes. */
  private syncMirrors(a: Live): void {
    const venue = a.venue;
    if (!venue || !venue.ready()) return; // demo agents trade demo money only
    const now = Date.now();
    const snap = this.snaps.get(a.rec.wallet);
    const paper = new Map(a.account.positions.map((p) => [p.id, p]));
    for (const p of paper.values()) {
      if (a.rec.mirrors.some((m) => m.simId === p.id) || now - p.openedAt > MIRROR_WINDOW_MS || p.closing) continue;
      const paperEq = a.account.equity((c) => this.feed.quote(c)?.mid, now);
      // The agent's whole wallet is its budget (capped by capitalUsd); real size mirrors the paper size as a share of equity.
      const budget = Math.min(a.rec.limits.capitalUsd, snap?.balanceUsd ?? a.rec.realEquity);
      const scale = paperEq > 0 ? budget / paperEq : 0;
      let margin = Math.floor(p.margin * scale * 100) / 100;
      if (snap) margin = Math.min(margin, Math.floor(snap.availableUsd * 100) / 100);
      const m: Mirror = { simId: p.id, coin: p.coin, side: p.side, leverage: Math.round(p.leverage), marginUsd: margin, status: 'opening', openedAt: now };
      a.rec.mirrors.push(m);
      if (margin < PT_MIN_MARGIN || margin * m.leverage < PT_MIN_NOTIONAL) {
        m.status = 'failed'; m.error = `real size too small for Papertrade (margin $${margin}, position $${(margin * m.leverage).toFixed(0)}; minimums $${PT_MIN_MARGIN} margin and $${PT_MIN_NOTIONAL} position value): fund the wallet more or size up`;
        this.note(a, m.error);
        continue;
      }
      void venue.open(p.coin, p.side, margin, m.leverage)
        .then((r) => { m.intentId = r.intentId; this.note(a, `opened ${p.side} ${p.coin} ${m.leverage}× $${margin}`); })
        .catch((e) => { m.status = 'failed'; m.error = (e as Error).message; this.note(a, `open failed: ${m.error}`); });
    }
    for (const m of a.rec.mirrors) {
      if ((m.status === 'open' || m.status === 'opening') && !paper.has(m.simId)) this.closeMirror(a, m);
    }
  }

  private closeMirror(a: Live, m: Mirror): void {
    if (!m.positionId) { m.status = 'closing'; return; } // closed by reconcile as soon as Papertrade reports its id
    m.status = 'closing';
    void a.venue?.close([m.positionId])
      .then(() => this.note(a, `closed ${m.side} ${m.coin}`))
      .catch((e) => { m.status = 'open'; this.note(a, `close failed, retrying: ${(e as Error).message}`); });
  }

  /** Per agent wallet: register local keys once funded, match real positions to mirrors (by intent id), finish pending
   *  closes, and settle realized P&L from Papertrade's own history. */
  async reconcile(): Promise<void> {
    for (const a of this.live.values()) {
      if (!a.venue) continue; // demo
      const w = findWallet(a.rec.wallet);
      if (w?.kind === 'local' && w.keyStatus !== 'active' && Date.now() - (this.lastKeyTry.get(w.address) ?? 0) > 60_000) {
        this.lastKeyTry.set(w.address, Date.now());
        const r = await registerLocalKey(w.address, (await netConfig()).builderAddress).catch((e) => ({ registered: false, reason: (e as Error).message }));
        if (r.registered) this.note(a, 'trading key registered on Papertrade: live trading on');
      }
      if (!a.venue.ready()) continue;
      const busy = a.rec.mirrors.some((m) => m.status === 'opening' || m.status === 'open' || m.status === 'closing');
      const prev = this.snaps.get(a.rec.wallet);
      if (!busy && prev && Date.now() - prev.at < 60_000) continue;
      const snap = await a.venue.snapshot().catch((e) => { this.note(a, `snapshot: ${(e as Error).message}`); return null; });
      if (!snap) continue;
      this.snaps.set(a.rec.wallet, { at: Date.now(), balanceUsd: snap.balanceUsd, availableUsd: snap.availableUsd, positions: snap.positions });
      if (!busy) a.rec.realEquity = snap.balanceUsd;
      const byIntent = new Map(snap.positions.map((p) => [p.intentId.toLowerCase(), p]));
      const byId = new Map(snap.positions.map((p) => [p.positionId, p]));
      let needTrades = false;
      for (const m of a.rec.mirrors) {
        if (m.status === 'closed' || m.status === 'failed') continue;
        const real = m.positionId ? byId.get(m.positionId) : m.intentId ? byIntent.get(m.intentId.toLowerCase()) : undefined;
        if (real && !m.positionId) { m.positionId = real.positionId; m.entry = real.entry; if (m.status === 'opening') m.status = 'open'; }
        if (m.status === 'closing' && m.positionId && real) { this.closeMirror(a, m); continue; }
        if (!real && m.positionId) {
          // Gone on Papertrade: closed by us, or liquidated. Keep the paper side in sync.
          m.status = 'closed'; m.closedAt = Date.now(); needTrades = true;
          if (a.account.positions.some((p) => p.id === m.simId)) a.account.submit([{ action: 'close', id: m.simId }], Date.now());
        }
        if (!real && !m.positionId && m.status === 'opening' && Date.now() - m.openedAt > 120_000) {
          m.status = 'failed'; m.error = 'never appeared on Papertrade';
          if (a.account.positions.some((p) => p.id === m.simId)) a.account.submit([{ action: 'close', id: m.simId }], Date.now());
        }
      }
      if (needTrades) await this.settlePnl(a).catch(() => {});
    }
  }

  /** Realized P&L straight from Papertrade's own trade history (adjusted P&L, after fees and the builder fee). */
  private async settlePnl(a: Live): Promise<void> {
    if (!a.venue) return;
    const res = await a.venue.trades();
    const pnlOf = new Map<string, number>();
    for (const t of res.items ?? []) {
      const id = String(t.positionId ?? t.position_id ?? t.id ?? '');
      const raw = t.adjustedPnlRaw ?? t.pnlRaw;
      if (id && raw != null) pnlOf.set(id, rawToUsd(String(raw).replace(/^-/, '')) * (String(raw).startsWith('-') ? -1 : 1));
    }
    for (const m of a.rec.mirrors) {
      if (m.status === 'closed' && m.pnlUsd == null && m.positionId && pnlOf.has(m.positionId)) {
        m.pnlUsd = pnlOf.get(m.positionId)!;
        this.note(a, `${m.side} ${m.coin} settled ${m.pnlUsd >= 0 ? '+' : ''}$${m.pnlUsd.toFixed(2)}`);
      }
    }
  }

  private dailyLossCheck(a: Live): void {
    const paperEq = a.account.equity((c) => this.feed.quote(c)?.mid, Date.now());
    // Demo agents are judged on demo equity; live ones on real equity plus open paper P&L.
    const unreal = paperEq - a.account.balance - a.account.positions.reduce((s, p) => s + p.margin, 0);
    const now = isDemo(a.rec) ? paperEq : a.rec.realEquity + unreal;
    if (a.rec.day.date !== today()) a.rec.day = { date: today(), start: now };
    if (a.rec.day.start > 0 && now < a.rec.day.start * (1 - a.rec.limits.maxDailyLossPct / 100)) {
      this.pause(a, `daily loss limit hit (${a.rec.limits.maxDailyLossPct}%): closed everything until you resume it`);
    }
  }

  pause(a: Live, reason: string): void {
    a.rec.status = 'paused';
    a.rec.pausedReason = reason;
    a.account.closeAllNow((c) => this.feed.quote(c)?.mid, Date.now());
    for (const m of a.rec.mirrors) if (m.status === 'open' || m.status === 'opening') this.closeMirror(a, m);
    this.note(a, `paused: ${reason}`);
    this.persist();
  }

  // ---------- control (called by the local HTTP API that the MCP tools use) ----------

  async createAgent(input: { name: string; thesis: string; code: string; params?: Record<string, unknown>; limits: Partial<Limits>; mode?: 'demo' | 'live'; wallet?: string; userApproved: boolean; model?: string; settings?: AgentSettings }) {
    if (input.userApproved !== true) throw new Error('refused: the user has not approved this agent. Present the research and the limits, and ask them first.');
    if (this.killSwitch) throw new Error('the kill switch is on: switch it off first');
    const demo = input.mode === 'demo';
    // Live: one agent, one strategy, one wallet (budgets are never shared). Demo: demo money only, no wallet.
    const w = demo ? undefined : this.freeWallet(input.wallet);
    const limits = validateLimits(input.limits);
    new StrategyRuntime(input.code, input.params ?? {}, []); // compile check
    const rec: AgentRecord = {
      id: randomUUID().slice(0, 8), mode: demo ? 'demo' : 'live', wallet: w?.address ?? '', name: String(input.name).slice(0, 60), thesis: String(input.thesis ?? '').slice(0, 2000), code: input.code, params: input.params ?? {},
      limits, settings: cleanSettings(input.settings, limits.capitalUsd), status: 'running', createdAt: Date.now(), model: input.model, realEquity: limits.capitalUsd, day: { date: today(), start: limits.capitalUsd }, mirrors: [], log: [],
    };
    this.instantiate(rec);
    if (w) updateWallet(w.address, { agentId: rec.id, label: rec.name });
    this.note(this.live.get(rec.id)!, demo ? `created on demo money ($${limits.capitalUsd}) with limits ${JSON.stringify(limits)}` : `created on wallet ${w!.address} (${w!.kind}) with limits ${JSON.stringify(limits)}`);
    this.register(rec);
    this.persist();
    return this.describe(rec.id);
  }

  private freeWallet(address?: string) {
    const w = address ? findWallet(address) : undefined;
    if (!w) throw new Error('a live agent needs its own wallet: create one with new_agent_wallet (generated on this computer) or connect_external_wallet (e.g. MetaMask), then pass its address. Or start with mode "demo" (demo money, no wallet).');
    if (w.agentId && this.live.has(w.agentId) && this.live.get(w.agentId)!.rec.status !== 'stopped') throw new Error(`wallet ${w.address} already runs agent ${w.agentId}: one agent per wallet`);
    return w;
  }

  /** Report the agent to PaperQuants (shown on the user's account page; live ones also on the verified leaderboard). */
  private register(rec: AgentRecord): void {
    if (!session()) return;
    const strategy = { name: rec.name, code: rec.code, params: rec.params, hash: createHash('sha256').update(rec.code + JSON.stringify(rec.params)).digest('hex').slice(0, 16) };
    api<{ id: number }>('/api/net/agents', { auth: true, body: { name: rec.name, venue: 'papertrade', mode: isDemo(rec) ? 'demo' : 'live', wallet: rec.wallet || null, strategy, limits: rec.limits, settings: rec.settings ?? {}, model: rec.model } })
      .then((r) => { rec.netId = r.id; this.persist(); void this.heartbeat(); }).catch(() => {});
  }

  /** A demo agent that did well goes live on its own wallet: same strategy and limits, real money from now on. */
  goLive(id: string, wallet: string, userApproved: boolean, capitalUsd?: number) {
    if (userApproved !== true) throw new Error('refused: ask the user to approve going live (real money) first');
    const a = this.get(id);
    if (!isDemo(a.rec)) throw new Error('this agent is already live');
    const w = this.freeWallet(wallet);
    const oldNet = a.rec.netId;
    a.account.closeAllNow((c) => this.feed.quote(c)?.mid, Date.now()); // start live flat
    a.rec.mode = 'live';
    a.rec.wallet = w.address;
    if (capitalUsd) a.rec.limits = validateLimits({ ...a.rec.limits, capitalUsd });
    a.rec.realEquity = a.rec.limits.capitalUsd;
    a.rec.day = { date: today(), start: a.rec.realEquity };
    a.rec.netId = undefined;
    a.venue = new PapertradeAdapter(w.address);
    updateWallet(w.address, { agentId: a.rec.id, label: a.rec.name });
    this.note(a, `went live on wallet ${w.address} (${w.kind})`);
    if (oldNet && session()) void api(`/api/net/agents/${oldNet}`, { method: 'PATCH', auth: true, body: { status: 'stopped' } }).catch(() => {});
    this.register(a.rec);
    this.persist();
    return this.describe(id);
  }

  updateLimits(id: string, patch: Partial<Limits>) {
    const a = this.get(id);
    a.rec.limits = validateLimits({ ...a.rec.limits, ...patch });
    this.note(a, `limits changed to ${JSON.stringify(a.rec.limits)}`);
    this.persist();
    return this.describe(id);
  }

  setStatus(id: string, status: 'running' | 'paused' | 'stopped') {
    const a = this.get(id);
    if (status === 'running') {
      if (this.killSwitch) throw new Error('the kill switch is on');
      a.rec.status = 'running'; a.rec.pausedReason = undefined; a.rec.day = { date: today(), start: a.rec.realEquity };
      this.note(a, 'resumed');
    } else this.pause(a, status === 'stopped' ? 'stopped by the user' : 'paused by the user');
    a.rec.status = status;
    this.persist();
    return this.describe(id);
  }

  setKill(on: boolean) {
    this.killSwitch = on;
    writeJson('kill.json', { on });
    if (on) for (const a of this.live.values()) if (a.rec.status === 'running') this.pause(a, 'kill switch');
    return { killSwitch: on };
  }

  private get(id: string): Live {
    const a = this.live.get(id);
    if (!a) throw new Error(`no agent ${id}`);
    return a;
  }

  describe(id: string) {
    const a = this.get(id);
    const now = Date.now();
    const mid = (c: Coin) => this.feed.quote(c)?.mid;
    const paperEq = a.account.equity(mid, now);
    return {
      id: a.rec.id, name: a.rec.name, mode: isDemo(a.rec) ? 'demo' : 'live', wallet: a.rec.wallet || null, walletKind: a.rec.wallet ? findWallet(a.rec.wallet)?.kind : null, liveTrading: !!a.venue?.ready(), status: a.rec.status, pausedReason: a.rec.pausedReason, limits: a.rec.limits, createdAt: new Date(a.rec.createdAt).toISOString(),
      realEquityUsd: isDemo(a.rec) ? null : Math.round(a.rec.realEquity * 100) / 100, demoEquityUsd: isDemo(a.rec) ? Math.round(paperEq * 100) / 100 : undefined, paper: summarize(a.account.stats, paperEq, a.rec.limits.capitalUsd),
      open: a.account.positions.map((p) => ({ coin: p.coin, side: p.side, leverage: p.leverage, margin: p.margin, entry: p.entry, ageSec: Math.round((now - p.openedAt) / 1000) })),
      realPositions: a.rec.mirrors.filter((m) => m.status === 'open' || m.status === 'opening' || m.status === 'closing'),
      recentReal: a.rec.mirrors.filter((m) => m.status === 'closed' || m.status === 'failed').slice(-10),
      settings: a.rec.settings, goalPace: this.pace(a.rec, isDemo(a.rec) ? paperEq : a.rec.realEquity),
      strategyErrors: a.runtime.errors, lastError: a.runtime.lastError, logs: a.runtime.logs.slice(-10), log: a.rec.log.slice(-15), thesis: a.rec.thesis,
    };
  }

  list() {
    return [...this.live.keys()].map((id) => {
      const d = this.describe(id);
      return { id: d.id, name: d.name, mode: d.mode, wallet: d.wallet, liveTrading: d.liveTrading, status: d.status, pausedReason: d.pausedReason, realEquityUsd: d.realEquityUsd, paperPnlPct: Math.round(d.paper.pnlPct * 10) / 10, trades: d.paper.trades, open: d.open.length };
    });
  }

  status() {
    return {
      feed: { connected: this.feed.connected, btc: this.feed.quote('BTC')?.mid, eth: this.feed.quote('ETH')?.mid },
      masterAccount: session()?.wallet ?? null,
      wallets: this.wallets(), killSwitch: this.killSwitch, keepingAwake: !!this.awake, agents: this.list(),
    };
  }

  /** Where the agent stands against its goal: the compounding path from start to target over the chosen days. */
  pace(rec: AgentRecord, equity: number) {
    const g = rec.settings?.goal;
    if (!g) return null;
    const days = (Date.now() - rec.createdAt) / 86_400_000;
    const perDay = (g.targetUsd / g.startUsd) ** (1 / g.days);
    const path = g.startUsd * perDay ** Math.min(days, g.days);
    return { target: g.targetUsd, byDay: g.days, neededPerDayPct: Math.round((perDay - 1) * 1000) / 10, pathNow: Math.round(path * 100) / 100, equity: Math.round(equity * 100) / 100,
      status: equity >= path ? 'ahead' : 'behind', daysLeft: Math.max(0, Math.round((g.days - days) * 10) / 10) };
  }

  /** Engine-wide settings: CPU priority (low keeps the computer snappy) and whether to keep it awake while trading. */
  config = readJson<{ priority: 'low' | 'normal'; keepAwake: boolean }>('engine.json', { priority: 'low', keepAwake: true });
  setConfig(c: Partial<{ priority: 'low' | 'normal'; keepAwake: boolean }>) {
    this.config = { ...this.config, ...(c.priority ? { priority: c.priority } : {}), ...(typeof c.keepAwake === 'boolean' ? { keepAwake: c.keepAwake } : {}) };
    writeJson('engine.json', this.config);
    this.applyPriority();
    if (!this.config.keepAwake && this.awake) { this.awake.kill(); this.awake = undefined; }
    return this.config;
  }
  applyPriority() {
    try { osSetPriority(process.pid, this.config.priority === 'low' ? 10 : 0); } catch { /* not allowed on this OS */ }
  }

  /** Every agent wallet with its balance, key state and agent. */
  wallets() {
    return loadWallets().map((w) => {
      const sn = this.snaps.get(w.address);
      return { address: w.address, kind: w.kind, label: w.label, agent: w.agentId ?? null, tradingKey: w.keyStatus, keyExpires: w.keyExpiry ? new Date(w.keyExpiry * 1000).toISOString() : null, linkedToAccount: !!w.linked,
        balanceUsd: sn?.balanceUsd ?? null, availableUsd: sn?.availableUsd ?? null, openPositions: sn?.positions.length ?? null };
    });
  }

  /** Prove a local wallet belongs to the signed-in master account (shown on the PaperQuants website). */
  async linkLocal(address: string): Promise<boolean> {
    const s = session();
    const w = findWallet(address);
    if (!s || !w || w.kind !== 'local' || w.linked) return !!w?.linked;
    const { ts, sig } = await signLinkLocal(address, s.wallet);
    await api('/api/net/wallets', { auth: true, body: { address: w.address, kind: 'local', label: w.label, ts, sig } });
    updateWallet(address, { linked: true });
    return true;
  }

  // ---------- housekeeping ----------

  private keepAwake(): void {
    const exposed = [...this.live.values()].some((a) => a.rec.mirrors.some((m) => m.status === 'open' || m.status === 'opening' || m.status === 'closing'));
    if (exposed && !this.awake && this.config.keepAwake) {
      const cmd = process.platform === 'darwin' ? ['caffeinate', ['-i', '-w', String(process.pid)]] as const
        : process.platform === 'linux' ? ['systemd-inhibit', ['--what=sleep:idle', '--why=PaperQuants has open trades', 'sleep', 'infinity']] as const : null;
      if (cmd) {
        this.awake = spawn(cmd[0], [...cmd[1]], { stdio: 'ignore' });
        this.awake.on('error', () => { this.awake = undefined; });
      }
    } else if (!exposed && this.awake) {
      this.awake.kill();
      this.awake = undefined;
    }
  }

  private note(a: Live | null, msg: string): void {
    const line = `${new Date().toISOString().slice(5, 19)} ${msg}`;
    if (a) { a.rec.log.push(line); if (a.rec.log.length > 200) a.rec.log.splice(0, a.rec.log.length - 200); }
    else console.error(`[engine] ${line}`);
  }

  persist(): void {
    for (const a of this.live.values()) {
      a.rec.account = a.account.snapshot(a.runtime.state);
      a.rec.mirrors = a.rec.mirrors.filter((m, i, arr) => !(m.status === 'closed' || m.status === 'failed') || i >= arr.length - 50);
    }
    writeJson('agents.json', [...this.live.values()].map((a) => a.rec));
  }

  /** Remember closed trades (demo trades included) for the website. */
  private closed(a: Live, trades: ClosedTrade[]): void {
    if (!trades.length) return;
    a.rec.recent ??= [];
    for (const t of trades) a.rec.recent.push({ openedAt: t.openedAt, closedAt: t.closedAt, coin: t.coin, side: t.side, lev: t.leverage, entry: t.entry, exit: t.exit, pnl: Math.round(t.pnl * 100) / 100, bps: Math.round((t.side === 'long' ? t.exit - t.entry : t.entry - t.exit) / t.entry * 1e6) / 100, reason: t.reason });
    if (a.rec.recent.length > 60) a.rec.recent.splice(0, a.rec.recent.length - 60);
  }

  /** Every minute: each agent's equity, positions, recent trades and curve go to PaperQuants for the website. */
  private lastCurve = 0;
  async heartbeat(): Promise<void> {
    if (!session()) return;
    const tick = Date.now() - this.lastCurve > 5 * 60_000;
    if (tick) this.lastCurve = Date.now();
    for (const a of this.live.values()) {
      if (!a.rec.netId) continue;
      const d = this.describe(a.rec.id);
      const equity = d.realEquityUsd ?? d.demoEquityUsd ?? 0;
      a.rec.curve ??= [a.rec.limits.capitalUsd];
      if (tick) { a.rec.curve.push(Math.round(equity * 100) / 100); if (a.rec.curve.length > 576) a.rec.curve.splice(0, a.rec.curve.length - 576); }
      const now = Date.now(), mid = (c: Coin) => this.feed.quote(c)?.mid;
      const positions = a.account.positions.map((p) => {
        const mark = mid(p.coin) ?? p.entry, bps = ((p.side === 'long' ? mark - p.entry : p.entry - mark) / p.entry) * 1e4;
        return { coin: p.coin, side: p.side, lev: p.leverage, margin: p.margin, entry: p.entry, mark, bps: Math.round(bps * 100) / 100, pnl: Math.round(p.margin * p.leverage * bps / 1e4 * 100) / 100, ageSec: Math.round((now - p.openedAt) / 1000) };
      });
      const snapshot = { stats: { trades: d.paper.trades, wins: d.paper.wins, winRate: d.paper.winRate, pnlPct: d.paper.pnlPct, maxDrawdownPct: d.paper.maxDrawdownPct },
        settings: a.rec.settings ?? {}, pace: this.pace(a.rec, equity), positions, trades: (a.rec.recent ?? []).slice(-30), equity: [...a.rec.curve, Math.round(equity * 100) / 100].slice(-120), log: a.rec.log.slice(-6), thesis: a.rec.thesis, coins: a.rec.limits.coins };
      await api(`/api/net/agents/${a.rec.netId}/heartbeat`, { auth: true, body: { equity, open: positions.length, status: d.status, snapshot } }).catch(() => {});
    }
  }
}
