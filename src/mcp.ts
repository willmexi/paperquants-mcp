// The MCP server the user's Claude talks to (stdio). Research and data come from PaperQuants and Hyperliquid;
// agents, limits and the kill switch go to the local engine, which holds the key and does the trading.
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { INSTRUCTIONS } from './instructions.ts';
import { VERSION } from './home.ts';
import { api } from './net.ts';
import { engine, connectUrl, ensureEngine } from './local.ts';
import { fetchCandles } from './engine/feed.ts';

const HL = 'https://api.hyperliquid.xyz/info';
const hl = (body: unknown) => fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }).then((r) => r.json());

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }] });
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try { return text(await fn(a)); } catch (e) { return { ...text(`error: ${(e as Error).message}`), isError: true }; }
};
const openBrowser = (url: string) => {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* the URL is returned too */ }
};

const coin = z.enum(['BTC', 'ETH']);
// Ready-made limit sets so Claude can offer one simple choice; any field can still be overridden.
const PRESETS = {
  careful: { maxLeverage: 100, maxMarginPctPerTrade: 10, maxDailyLossPct: 20 },
  balanced: { maxLeverage: 300, maxMarginPctPerTrade: 25, maxDailyLossPct: 35 },
  aggressive: { maxLeverage: 500, maxMarginPctPerTrade: 40, maxDailyLossPct: 50 },
  degen: { maxLeverage: 1000, maxMarginPctPerTrade: 50, maxDailyLossPct: 70, riskProfile: 'DEGEN' as const },
};
const limits = z.object({
  maxLeverage: z.number().int().min(1).max(1000).describe('Highest leverage any order may use (Papertrade allows up to 1000×).'),
  capitalUsd: z.number().positive().describe('How much of the Papertrade account this agent may trade with, in USD.'),
  maxMarginPctPerTrade: z.number().min(1).max(50).describe("One position's margin as % of the agent's equity (max 50)."),
  maxDailyLossPct: z.number().min(1).max(100).describe('The agent pauses and closes everything after losing this % in a UTC day.'),
  coins: z.array(coin).min(1),
  riskProfile: z.enum(['DEGEN']).optional().describe('DEGEN: every order must be 500×+ and at least 6% of equity.'),
});

/** Which AI app is driving us, from the MCP handshake (Claude Code, the Claude app, ChatGPT, Cursor...). */
function clientApp(server: McpServer): string {
  const n = (server.server.getClientVersion()?.name ?? '').toLowerCase();
  return n.includes('claude') ? 'Claude' : n.includes('chatgpt') || n.includes('openai') ? 'ChatGPT' : n.includes('gemini') ? 'Gemini' : n.includes('cursor') ? 'Cursor' : n ? n.slice(0, 20) : 'AI';
}
/** "Claude · Opus 5.5": the app (forced from the handshake) plus the model the LLM reports. */
const modelLabel = (app: string, model: string) => `${app} · ${model.replace(new RegExp(`^${app}\\s*`, 'i'), '').trim()}`;

export async function runMcp(): Promise<void> {
  const server = new McpServer({ name: 'paperquants', version: VERSION }, { instructions: INSTRUCTIONS });

  // ---- account and agent wallets ----
  server.registerTool('status', { description: 'Start here. Master account (sign-in), every agent wallet (balance, trading key), kill switch and every agent with its P&L.', inputSchema: {} },
    wrap(async () => engine('/status')));
  server.registerTool('sign_in', { description: "Open the local sign-in page in the user's browser: they sign once with their main wallet (e.g. MetaMask). That wallet is their PaperQuants account; agent wallets get linked to it and shown on their account page.", inputSchema: {} },
    wrap(async () => { await ensureEngine(); const url = connectUrl('login'); openBrowser(url); return { opened: url, next: 'Ask the user to sign in their wallet, then call status.' }; }));
  server.registerTool('new_agent_wallet', { description: 'Generate a fresh wallet on this computer for ONE new agent (stored encrypted in ~/.paperquants, linked to their account automatically). Returns its Papertrade deposit address; the engine registers the trading key itself once the deposit lands. The easiest option.', inputSchema: { label: z.string().min(2).max(60).describe('Usually the agent name.') } },
    wrap(async ({ label }) => engine('/wallets/local', { label })));
  server.registerTool('connect_external_wallet', { description: "Open the local page to connect one of the user's own wallet accounts (e.g. a MetaMask account) as ONE agent's wallet: they sign a link to their account and a trade-only Papertrade key. The wallet needs a Papertrade deposit first.", inputSchema: { label: z.string().min(2).max(60) } },
    wrap(async ({ label }) => { await ensureEngine(); const url = connectUrl('wallet', label); openBrowser(url); return { opened: url, next: 'Ask the user to pick the account and sign both steps, then call list_wallets.' }; }));
  server.registerTool('list_wallets', { description: 'Every agent wallet: local or external, balance on Papertrade, trading key state, which agent uses it.', inputSchema: {} },
    wrap(async () => engine('/wallets')));
  server.registerTool('deposit_info', { description: "An agent wallet's personal Papertrade deposit address (USDC on HyperCore, min 10 USDC).", inputSchema: { wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/) } },
    wrap(async ({ wallet }) => engine(`/wallets/${wallet}/deposit`)));
  server.registerTool('my_account', { description: "The user's PaperQuants account page (their agents, wallets and verified results). Share the link.", inputSchema: {} },
    wrap(async () => engine('/account')));
  server.registerTool('sweep_wallet', { description: "Move USDC from a LOCAL agent wallet back to the user's main wallet (Papertrade → Hyperliquid → main wallet). The agent must be paused. Only with the user's explicit approval.", inputSchema: { wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/), amount_usd: z.number().positive(), user_approved: z.boolean() } },
    wrap(async ({ wallet, amount_usd, user_approved }) => { if (!user_approved) throw new Error('refused: ask the user first'); return engine(`/wallets/${wallet}/sweep`, { amountUsd: amount_usd }); }));
  server.registerTool('export_wallet_key', { description: "Reveal a LOCAL agent wallet's private key so the user can import it into their own wallet app. Only when the user explicitly asks for it; warn them never to share it.", inputSchema: { wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/), user_confirmed: z.boolean() } },
    wrap(async ({ wallet, user_confirmed }) => engine(`/wallets/${wallet}/export`, { confirm: user_confirmed })));

  // ---- data ----
  server.registerTool('market_snapshot', { description: 'Live BTC/ETH mark, 24h change, funding and open interest from Hyperliquid (the prices Papertrade settles on).', inputSchema: {} },
    wrap(async () => {
      const [meta, ctx] = await hl({ type: 'metaAndAssetCtxs' });
      return ['BTC', 'ETH'].map((c) => {
        const i = meta.universe.findIndex((u: { name: string }) => u.name === c);
        const x = ctx[i] ?? {};
        const mark = +x.markPx, prev = +x.prevDayPx;
        return { coin: c, mark, change24hPct: prev ? Math.round(((mark - prev) / prev) * 10000) / 100 : null, fundingPctPerHour: +x.funding * 100, openInterest: +x.openInterest, dayVolumeUsd: +x.dayNtlVlm };
      });
    }));
  server.registerTool('candles', { description: 'OHLCV candles from Hyperliquid (1m, 5m, 15m, 1h, 4h, 1d), up to 5000.', inputSchema: { coin, tf: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']), limit: z.number().int().min(1).max(5000).default(200) } },
    wrap(async ({ coin, tf, limit }) => {
      const ms = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 }[tf];
      const now = Date.now();
      return (await fetchCandles(coin, now - limit * ms, now, tf)).slice(-limit);
    }));
  server.registerTool('funding', { description: 'Hourly funding rate history from Hyperliquid (positive = longs pay shorts).', inputSchema: { coin, hours: z.number().int().min(1).max(2000).default(168) } },
    wrap(async ({ coin, hours }) => (await hl({ type: 'fundingHistory', coin, startTime: Date.now() - hours * 3600e3 })).map((r: { time: number; fundingRate: string }) => ({ t: new Date(r.time).toISOString(), ratePct: +r.fundingRate * 100 }))));

  // ---- research ----
  server.registerTool('brain', { description: "What the PaperQuants network knows: validated findings (supported / hypothesis / refuted), the playbook, and each market's latest read.", inputSchema: {} },
    wrap(async () => api('/api/net/data/brain').catch(() => api('/api/public/brain'))));
  server.registerTool('lab_results', { description: 'Results from the PaperQuants research lab: strategy families backtested nonstop, with in-sample and locked out-of-sample verdicts.', inputSchema: {} },
    wrap(async () => api('/api/net/data/lab').catch(() => api('/api/public/research?limit=50'))));
  server.registerTool('leaderboard', { description: "Agents in the PaperQuants network ranked by P&L verified from Papertrade's own trade history.", inputSchema: {} },
    wrap(async () => api('/api/net/leaderboard')));
  server.registerTool('backtest', {
    description: 'Backtest strategy code on a 1-second replay that copies Papertrade exactly (payout curve, bust line, fees, 1s latency). Returns stats plus an in-sample/out-of-sample robustness verdict. The code defines function onTick(ctx) returning actions like {action:"open", coin:"BTC", side:"long", marginPct:25, leverage:500, tpBps:30, slBps:12, maxHoldSec:1800}; ctx has now, markets, positions, balance, equity, state, history(coin,sec), candles(coin,n), bars(coin,tf,n), ind.',
    inputSchema: { code: z.string(), params: z.record(z.string(), z.any()).optional(), hours: z.number().min(1).max(72).default(24) },
  }, wrap(async (a) => api('/api/net/backtest', { auth: true, body: a, timeoutMs: 600_000 })));
  server.registerTool('sweep', {
    description: 'Run a parameter grid of the same code on the 1-second replay (up to 48 combinations, ≤24h window) and return the best combinations. Validate the winner with a 72h backtest.',
    inputSchema: { code: z.string(), base_params: z.record(z.string(), z.any()).optional(), grid: z.record(z.string(), z.array(z.any())), hours: z.number().min(1).max(24).default(24), top: z.number().int().min(1).max(10).default(5) },
  }, wrap(async (a) => api('/api/net/sweep', { auth: true, body: a, timeoutMs: 900_000 })));
  server.registerTool('submit_research', {
    description: "Publish a finding to PaperQuants. The validator re-tests it; if it holds it joins the shared brain, credited to the user. Include concrete evidence (backtest numbers, out-of-sample result) and the strategy code/params if any.",
    inputSchema: { claim: z.string().min(20), scope: z.string().optional(), evidence: z.record(z.string(), z.any()), code: z.string().optional(), params: z.record(z.string(), z.any()).optional() },
  }, wrap(async (a) => api('/api/net/research', { auth: true, body: a })));
  server.registerTool('my_research', { description: "The user's submitted findings and the validator's verdicts.", inputSchema: {} },
    wrap(async () => api('/api/net/research?mine=1', { auth: true })));

  // ---- agents (local engine) ----
  server.registerTool('strategy_menu', { description: 'Ready-to-run PaperQuants strategies with honest confidence scores (0–100), why, coins, suggested risk preset and the code. Call this FIRST when the user wants a trading agent, then ask one question.', inputSchema: {} },
    wrap(async () => (await api<Array<Record<string, unknown>>>('/api/net/strategies')).map(({ code, ...m }) => ({ ...m, codeChars: String(code).length }))));
  server.registerTool('create_trading_agent', {
    description: "Start an agent that runs the strategy code every second within the limits. Default mode is demo: $1,000 of demo money on live prices, no wallet, nothing real traded, so create it as soon as the user picks a strategy and a limit preset. mode live (real money, its own wallet) only after explicit approval; use go_live for a demo agent that did well.",
    inputSchema: {
      name: z.string().min(3).max(24).regex(/^[A-Za-z0-9 ]+$/).refine((n) => !/\b(demo|live|test|agent|bot)\b/i.test(n), 'no demo/live/test/agent/bot in the name: the site shows the mode itself')
        .describe('A short, memorable name of 1–3 words, like "Night Owl" or "Spike Fader". No "demo"/"live", no leverage numbers.'),
      ai_model: z.string().min(2).max(40).describe('YOUR exact model name and version, e.g. "Opus 5.5", "Sonnet 5.5", "GPT-5". Shown on the website as "<username>-<app> · <model>".'),
      strategy: z.string().optional().describe('A strategy_menu key (e.g. "trend"): uses its code and params, no code needed.'),
      thesis: z.string().optional().describe('Why it should make money and what would prove it wrong (taken from the menu if strategy is set).'), code: z.string().optional(), params: z.record(z.string(), z.any()).optional(),
      preset: z.enum(['careful', 'balanced', 'aggressive', 'degen']).optional().describe('careful 100× / 10% per trade / 20% daily stop · balanced 300× / 25% / 35% · aggressive 500× / 40% / 50% · degen 1000× / 50% / 70%. Coins and capital still apply.'),
      limits: limits.partial().optional().describe('Overrides on top of the preset. Defaults: capitalUsd 1000 (demo money), coins BTC+ETH.'),
      mode: z.enum(['demo', 'live']).default('demo').describe('demo (default) = demo money, no wallet. live = real money on its own wallet.'),
      wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("Live only: this agent's OWN wallet (from new_agent_wallet or connect_external_wallet). One agent per wallet, never shared."), user_approved: z.boolean() },
  }, wrap(async ({ user_approved, preset, limits: l, ai_model, strategy, ...a }) => {
    if (strategy) {
      const m = (await api<Array<{ key: string; code: string; params: Record<string, unknown>; why: string; coins: string[] }>>('/api/net/strategies')).find((x) => x.key === strategy);
      if (!m) throw new Error(`no strategy "${strategy}" in strategy_menu`);
      a.code = m.code; a.params = { ...m.params, ...(a.params ?? {}) }; a.thesis ??= m.why;
      l = { coins: m.coins as never, ...(l ?? {}) };
    }
    if (!a.code) throw new Error('pass strategy (a strategy_menu key) or your own code');
    return engine('/agents', {
    ...a, limits: { capitalUsd: 1000, coins: ['BTC', 'ETH'], ...(preset ? PRESETS[preset] : PRESETS.balanced), ...(l ?? {}) },
    userApproved: a.mode === 'demo' ? true : user_approved, model: modelLabel(clientApp(server), ai_model),
  }); }));
  server.registerTool('go_live', {
    description: "Switch a demo agent to real money on its own wallet (same strategy and limits; capitalUsd can be set). Only after the user saw its demo results and explicitly approved real money.",
    inputSchema: { id: z.string(), wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/), capital_usd: z.number().positive().optional(), user_approved: z.boolean() },
  }, wrap(async ({ id, wallet, capital_usd, user_approved }) => engine(`/agents/${id}/live`, { wallet, capitalUsd: capital_usd, userApproved: user_approved })));
  server.registerTool('list_agents', { description: 'Every local agent: status, real equity, paper P&L, trades, open positions.', inputSchema: {} },
    wrap(async () => engine('/agents')));
  server.registerTool('agent_detail', { description: 'One agent in full: limits, real and paper positions, recent real trades and P&L, strategy errors and its log.', inputSchema: { id: z.string() } },
    wrap(async ({ id }) => engine(`/agents/${id}`)));
  server.registerTool('update_limits', { description: "Change an agent's limits. Only with the user's explicit approval; never raise limits on your own.", inputSchema: { id: z.string(), limits: limits.partial(), user_approved: z.boolean() } },
    wrap(async ({ id, limits, user_approved }) => { if (!user_approved) throw new Error('refused: ask the user to approve the new limits first'); return engine(`/agents/${id}/limits`, limits); }));
  server.registerTool('pause_agent', { description: 'Pause an agent: closes its positions and stops new trades until resumed.', inputSchema: { id: z.string() } },
    wrap(async ({ id }) => engine(`/agents/${id}/status`, { status: 'paused' })));
  server.registerTool('resume_agent', { description: 'Resume a paused agent (resets its daily-loss baseline).', inputSchema: { id: z.string() } },
    wrap(async ({ id }) => engine(`/agents/${id}/status`, { status: 'running' })));
  server.registerTool('kill_all', { description: 'Emergency stop: closes every position the engine opened and blocks all new trades until switched off (on=false).', inputSchema: { on: z.boolean().default(true) } },
    wrap(async ({ on }) => engine('/kill', { on })));

  // A slash command in Claude Code (/mcp__paperquants__start) and a prompt in the Claude app: the guided setup.
  server.registerPrompt('start', { description: 'Set me up with PaperQuants (guided, one step at a time)' },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Set me up with PaperQuants. Check my status and tell me the one next step.' } }] }));

  await server.connect(new StdioServerTransport());
}
