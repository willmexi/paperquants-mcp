// Real Papertrade client (spec: docs/PAPERTRADE.md). Builds and signs intents exactly like Papertrade's own web app and
// talks to its relayer from our server. Pure functions (typed data, serialization, units) are separate from the network
// calls so they can be tested offline. Nothing here checks risk: callers go through src/live/executor.ts.
import { createPublicClient, http, keccak256, toBytes, concat, hashTypedData, parseSignature, parseUnits, formatUnits, getAddress, type Hex, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';

export const CHAIN_ID = 999;
export const RPC = process.env.HYPEREVM_RPC ?? 'https://rpc.hyperliquid.xyz/evm';
export const API = process.env.PAPERTRADE_API ?? 'https://exchange.papertrade.xyz';
export const CONTRACTS = {
  exchange: '0x6cd5661646289FB6E65EA5C032310fDEd797D0a2',
  sessionKeyManager: '0x8326Eb8896e358717f10502Ec73CE8D28E37B108',
  depositFactory: '0x1629b7D46bef6E13FF754174FC9F32dEa309b38F',
  builderRegistry: '0xFdc6550436Dd75Ce8a0B145f935B7D3A64F53248',
} as const satisfies Record<string, Address>;
export const ZERO: Address = '0x0000000000000000000000000000000000000000';
export const INSTRUMENTS: Record<string, { id: number; priceScale: number }> = { BTC: { id: 0, priceScale: 10 }, ETH: { id: 1, priceScale: 100 } };
export const coinOf = (instrumentId: number) => Object.entries(INSTRUMENTS).find(([, v]) => v.id === instrumentId)?.[0] ?? String(instrumentId);
export const SESSION_TTL_SEC = 30 * 86400;
const DEADLINE_SEC = 3600;

export const DOMAIN = { name: 'String', version: '1', chainId: CHAIN_ID, verifyingContract: CONTRACTS.exchange } as const;
export const TYPES = {
  RegisterSessionKey: [
    { name: 'user', type: 'address' }, { name: 'key', type: 'address' }, { name: 'expiry', type: 'uint64' },
    { name: 'feeAddress', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ],
  OpenPosition: [
    { name: 'user', type: 'address' }, { name: 'instrumentId', type: 'uint32' }, { name: 'isLong', type: 'bool' }, { name: 'size', type: 'uint128' },
    { name: 'leverage', type: 'uint32' }, { name: 'useDebt', type: 'bool' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ],
  Close: [{ name: 'user', type: 'address' }, { name: 'positionIds', type: 'uint256[]' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }],
  WithdrawToCore: [{ name: 'user', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }],
} as const;
export type IntentType = keyof typeof TYPES;

export const deadline = (nowMs = Date.now()) => BigInt(Math.floor(nowMs / 1000) + DEADLINE_SEC);
/** Any unused uint256 works; random 120 bits keeps collisions out of reach. */
export const freshNonce = () => BigInt('0x' + randomBytes(15).toString('hex'));
/** Margin in USDC → the 18-decimal `size` field. */
export const marginToSize = (usd: number) => parseUnits(usd.toFixed(6), 18);
export const rawToUsd = (raw: string | bigint) => Number(formatUnits(BigInt(raw), 18));
export const rawToPrice = (raw: string | bigint, coin: string) => Number(BigInt(raw)) / (INSTRUMENTS[coin]?.priceScale ?? 1);

/** Typed data the user's wallet signs (eth_signTypedData_v4) to let an agent key trade. Sent to the browser as JSON. */
export function registrationTypedData(user: Address, key: Address, feeAddress: Address = ZERO, nowMs = Date.now()) {
  const message = { user, key, expiry: BigInt(Math.floor(nowMs / 1000) + SESSION_TTL_SEC), feeAddress, nonce: freshNonce(), deadline: deadline(nowMs) };
  return { domain: DOMAIN, types: { RegisterSessionKey: TYPES.RegisterSessionKey }, primaryType: 'RegisterSessionKey' as const, message };
}

/** Serialize a message the way Papertrade's app does (uint → decimal string, address/bytes → lowercase, bool as-is). */
export function serialize(type: IntentType, message: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { name, type: t } of TYPES[type]) {
    const v = message[name];
    out[name] = t === 'uint256[]' ? (v as Array<bigint | string>).map((x) => BigInt(x).toString())
      : t.startsWith('uint') ? BigInt(v as bigint).toString()
      : t === 'address' || t.startsWith('bytes') ? String(v).toLowerCase()
      : v;
  }
  return out;
}

/** v/r/s in the relayer's format. */
export function splitSig(sig: Hex) {
  const { r, s, yParity } = parseSignature(sig);
  return { v: String(27 + (yParity ?? 0)), r: r.toLowerCase(), s: s.toLowerCase() };
}

export function digest(type: IntentType, message: Record<string, unknown>): Hex {
  return hashTypedData({ domain: DOMAIN, types: { [type]: TYPES[type] } as any, primaryType: type, message: message as any });
}

/** Papertrade's intent id: keccak(keccak("papertrade:intent-id:v2") ‖ digest ‖ signer). */
export function intentId(type: IntentType, message: Record<string, unknown>, signer: Address): Hex {
  return keccak256(concat([keccak256(toBytes('papertrade:intent-id:v2')), digest(type, message), signer.toLowerCase() as Hex]));
}

/** Sign an intent with an agent's session key; returns the body `signed` field plus our computed intent id. */
export async function signWithSessionKey(type: 'OpenPosition' | 'Close', sessionKey: Hex, message: Record<string, unknown>) {
  const account = privateKeyToAccount(sessionKey);
  const sig = await account.signTypedData({ domain: DOMAIN, types: { [type]: TYPES[type] } as any, primaryType: type, message: message as any });
  return { signed: { ...serialize(type, message), ...splitSig(sig) }, intentId: intentId(type, message, account.address) };
}

export function openMessage(user: Address, coin: string, isLong: boolean, marginUsd: number, leverage: number) {
  const inst = INSTRUMENTS[coin];
  if (!inst) throw new Error(`Papertrade has no ${coin} market (BTC and ETH only)`);
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > 1000) throw new Error(`leverage must be an integer 1..1000, got ${leverage}`);
  return { user, instrumentId: inst.id, isLong, size: marginToSize(marginUsd), leverage, useDebt: false, nonce: freshNonce(), deadline: deadline() };
}

export const closeMessage = (user: Address, positionIds: Array<string | bigint>) => {
  if (!positionIds.length || positionIds.length > 12) throw new Error('a Close takes 1..12 position ids');
  return { user, positionIds: positionIds.map((x) => BigInt(x)), nonce: freshNonce(), deadline: deadline() };
};

// ---------- network ----------

let build: { id: string; at: number } | undefined;
/** Papertrade's current build id (sent as X-Papertrade-Build). Read from the app's build module; refreshed hourly. */
export async function buildId(force = false): Promise<string> {
  if (!force && build && Date.now() - build.at < 3600_000) return build.id;
  const html = await (await fetch(`${API}/`, { signal: AbortSignal.timeout(15_000) })).text();
  const scripts = [...html.matchAll(/assets\/[\w.-]+\.js/g)].map((m) => m[0]);
  let mod = scripts.find((s) => /\/build-[\w-]+\.js$/.test(s));
  if (!mod) {
    for (const s of scripts.slice(0, 8)) {
      const js = await (await fetch(`${API}/${s}`, { signal: AbortSignal.timeout(15_000) })).text();
      mod = js.match(/build-[\w-]+\.js/)?.[0];
      if (mod) { mod = `assets/${mod}`; break; }
    }
  }
  if (!mod) throw new Error('could not find Papertrade build module');
  const js = await (await fetch(`${API}/${mod}`, { signal: AbortSignal.timeout(15_000) })).text();
  const id = js.match(/var e=`([0-9a-f]{8,})`/)?.[1];
  if (!id) throw new Error('could not read Papertrade build id');
  build = { id, at: Date.now() };
  return id;
}

export class RelayerError extends Error {
  status: number; code?: string;
  constructor(status: number, code: string | undefined, message: string) { super(message); this.status = status; this.code = code; }
}

async function post<T>(path: string, body: unknown, timeoutMs = 35_000): Promise<T> {
  const send = async (b: string) => fetch(`${API}${path}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Papertrade-Build': b },
    body: JSON.stringify(body),
  });
  let r = await send(await buildId());
  if (r.status === 409 || r.status === 426) r = await send(await buildId(true)); // stale build id after a Papertrade deploy
  const text = await r.text();
  let json: any;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text.slice(0, 300) }; }
  if (!r.ok || json?.ok === false) {
    const reason = json?.reason ?? json?.message;
    throw new RelayerError(r.status, json?.reason ?? json?.code ?? json?.error, reason ? `Papertrade: ${json?.code ? json.code + ' · ' : ''}${reason}` : `Papertrade HTTP ${r.status}`);
  }
  return json as T;
}

export interface IntentAck { intentId: Hex; action: string; state: string; queueRevision?: string }
const ACCEPTED = new Set(['queued', 'prepared', 'confirmed']);

export async function submitIntent(action: 'registerSessionKey' | 'openPosition' | 'closePositions' | 'withdrawToCore', signed: Record<string, unknown>): Promise<IntentAck> {
  const ack = await post<IntentAck>('/intents', { action, signed }, action === 'registerSessionKey' ? 15_000 : 35_000);
  if (!ACCEPTED.has(ack.state)) throw new RelayerError(200, ack.state, `intent ${ack.intentId} not accepted (state ${ack.state})`);
  return ack;
}

/** Submit a RegisterSessionKey the user signed in their wallet. */
export async function submitRegistration(message: ReturnType<typeof registrationTypedData>['message'], userSignature: Hex) {
  return submitIntent('registerSessionKey', { ...serialize('RegisterSessionKey', message), ...splitSig(userSignature) });
}

/** Registers (if needed) and returns the user's personal HyperCore deposit address. */
export async function depositAddress(user: Address): Promise<Address> {
  // The relayer only accepts a lowercase address here (checksummed → HTTP 400).
  const r = await post<{ proxy: Address }>('/funding/deposits/check', { user: user.toLowerCase() }, 15_000);
  return getAddress(r.proxy);
}

const chain = { id: CHAIN_ID, name: 'HyperEVM', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
export const rpc = createPublicClient({ chain, transport: http(RPC) });

/** The deposit address straight from the factory contract (no relayer call). */
export async function computeDepositAddress(user: Address): Promise<Address> {
  return rpc.readContract({ address: CONTRACTS.depositFactory, abi: [{ type: 'function', name: 'computeProxyAddress', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'address' }] }], functionName: 'computeProxyAddress', args: [getAddress(user)] }) as Promise<Address>;
}

export interface LivePosition { positionId: string; coin: string; isLong: boolean; useDebt: boolean; entry: number; marginUsd: number; leverage: number; bust: number; openedAtMs: number; intentId: string }
export interface WalletSnapshot { balanceUsd: number; availableUsd: number; queuedUsd: number; positions: LivePosition[]; sessionKeys: unknown; operations: unknown; raw: any }

export function parseSnapshot(w: any): WalletSnapshot {
  const usd = (x: unknown) => (x == null ? 0 : rawToUsd(String(x)));
  const positions: LivePosition[] = (w.openPositions ?? []).map((p: any[]) => {
    const coin = coinOf(Number(p[1]));
    return { positionId: String(p[0]), coin, isLong: !!p[2], useDebt: !!p[3], entry: rawToPrice(String(p[4]), coin), marginUsd: usd(p[5]), leverage: Number(p[6]), bust: rawToPrice(String(p[7]), coin), openedAtMs: Number(p[8]), intentId: String(p[9]) };
  });
  return { balanceUsd: usd(w.balance), availableUsd: usd(w.funds?.availableBalance ?? w.balance), queuedUsd: usd(w.queued), positions, sessionKeys: w.sessionKeys, operations: w.operations, raw: w };
}

/** One full account snapshot from the live SSE stream (first `wallet` event), then the connection is closed. */
export async function walletSnapshot(wallet: Address, timeoutMs = 15_000): Promise<WalletSnapshot> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}/state/user/live?wallet=${getAddress(wallet)}`, { headers: { Accept: 'text/event-stream' }, signal: ctl.signal });
    if (!r.ok || !r.body) throw new Error(`state stream HTTP ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k: number;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k);
        buf = buf.slice(k + 2);
        const event = block.match(/^event: ?(.*)$/m)?.[1]?.trim();
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (event === 'wallet' && data) {
          const parsed = JSON.parse(data);
          return parseSnapshot(parsed.snapshot ?? parsed.wallet ?? parsed);
        }
      }
    }
    throw new Error('state stream ended before a wallet snapshot');
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

/** Papertrade's live trading rules: minimum margin and position value, max leverage, and whether trading is paused. */
export async function tradingRules(): Promise<{ minMarginUsd: number; minNotionalUsd: number; maxLeverage: number; paused: boolean; winFeePct: number }> {
  const r = await fetch(`${API}/state/trading`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`trading rules HTTP ${r.status}`);
  const d = (await r.json()) as { minimumTradeSizeRaw: string; minimumOpenNotionalRaw: string; maximumLeverage?: number; tradingPaused: boolean; winFeeRateRaw: string };
  return { minMarginUsd: rawToUsd(d.minimumTradeSizeRaw), minNotionalUsd: rawToUsd(d.minimumOpenNotionalRaw), maxLeverage: d.maximumLeverage ?? 1000, paused: !!d.tradingPaused, winFeePct: rawToUsd(d.winFeeRateRaw) * 100 };
}

/** Closed trades from Papertrade's indexer (newest first). */
export async function closedTrades(wallet: Address, limit = 75, cursor?: string): Promise<{ items: any[]; nextCursor: string | null }> {
  // The indexer only accepts a lowercase address and limit=75 (anything else: "path and query must contain only this
  // route's parameters"); `cursor` pages back (nextCursor).
  void limit;
  const r = await fetch(`${API}/query/accounts/${wallet.toLowerCase()}/trades?limit=75${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`trades HTTP ${r.status}`);
  return r.json();
}

// ---------- leaderboard display names (signed by the owner's wallet, personal_sign) ----------

export const NAME_PREFIX = 'paperquant_';
/** Papertrade name rules: 1–24 chars of letters, marks, numbers, spaces, dots, underscores, dashes. */
export function leaderboardName(agentName: string, n = 1): string {
  const base = agentName.normalize('NFKC').replace(/\s+/g, '').replace(/[^\p{L}\p{M}\p{N}._-]/gu, '');
  const suffix = n > 1 ? String(n) : '';
  return (NAME_PREFIX + base.slice(0, 24 - NAME_PREFIX.length - suffix.length) + suffix).slice(0, 24);
}

/** The exact text Papertrade's app asks the wallet to sign for a name change. */
export function nameMessage(address: string, name: string, signedAtMs: number, action: 'set' | 'clear' = 'set'): string {
  return ['Papertrade leaderboard name', `Address: ${address.toLowerCase()}`, `Action: ${action}`, `Name: ${name}`, `Timestamp: ${signedAtMs}`, '',
    'This signature only updates your public leaderboard display name.'].join('\n');
}

export async function setLeaderboardName(address: string, name: string, signedAtMs: number, signature: Hex) {
  const r = await fetch(`${API}/query/leaderboard/name`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ address: address.toLowerCase(), action: 'set', name, signedAtMs, signature }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new RelayerError(r.status, j?.code, j?.error ?? j?.message ?? `HTTP ${r.status}`);
  return j as { ok: true; address: string; leaderboardName: string | null; changed?: boolean; nextNameChangeAtMs?: number | null };
}
