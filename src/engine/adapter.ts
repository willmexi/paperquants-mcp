// One small translator per venue. The engine only speaks VenueAdapter; Papertrade is the only venue for now.
// Every agent has its OWN wallet (never a shared budget): either generated on this computer ("local") or the user's
// own external wallet such as MetaMask ("external"). Either way trading uses a trade-only session key kept here.
import { getAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  DOMAIN, TYPES, ZERO, registrationTypedData, submitRegistration, submitIntent, signWithSessionKey, openMessage, closeMessage,
  walletSnapshot, depositAddress, closedTrades, serialize, splitSig, deadline, freshNonce, marginToSize, type WalletSnapshot, type LivePosition,
} from '../../core/live/papertrade.ts';
import { seal, open } from '../../core/live/vault.ts';
import { readJson, writeJson } from '../home.ts';

export interface VenueLimits { maxLeverage: number; minMarginUsd: number; coins: string[]; nativeExits: boolean }

export interface VenueAdapter {
  readonly venue: string;
  readonly address: Address;
  limits(): VenueLimits;
  ready(): boolean;
  snapshot(): Promise<WalletSnapshot>;
  open(coin: string, side: 'long' | 'short', marginUsd: number, leverage: number): Promise<{ intentId: string }>;
  close(positionIds: string[]): Promise<void>;
  depositAddress(): Promise<Address>;
  trades(): Promise<{ items: any[] }>;
}

export interface WalletRecord {
  address: string;                   // lowercase
  kind: 'local' | 'external';
  label: string;
  createdAt: number;
  sealedWallet?: string;             // local wallets only: the wallet's own key, sealed (it can withdraw: never leaves this computer)
  key?: string;                      // session key address
  sealedKey?: string;                // session key, sealed
  keyExpiry?: number;                // unix seconds
  feeAddress?: string;
  keyStatus: 'none' | 'pending' | 'active';
  pendingMessage?: Record<string, string>;
  linked?: boolean;                  // proven to PaperQuants as belonging to the signed-in master account
  agentId?: string;                  // one agent per wallet
}

export const loadWallets = () => readJson<WalletRecord[]>('wallets.json', []);
export const saveWallets = (w: WalletRecord[]) => writeJson('wallets.json', w);
export function updateWallet(address: string, patch: Partial<WalletRecord>): WalletRecord {
  const all = loadWallets();
  const i = all.findIndex((w) => w.address === address.toLowerCase());
  if (i < 0) throw new Error(`no wallet ${address}`);
  all[i] = { ...all[i], ...patch };
  saveWallets(all);
  return all[i];
}
export const findWallet = (address: string) => loadWallets().find((w) => w.address === address.toLowerCase());

/** The typed data a wallet signs to register a trade-only session key (with our builder fee address). */
function newKeyRequest(wallet: string, builderAddress: string) {
  const pk = generatePrivateKey();
  const key = privateKeyToAccount(pk).address;
  const fee = (builderAddress || ZERO) as Address;
  const td = registrationTypedData(getAddress(wallet), key, fee);
  const message = Object.fromEntries(Object.entries(td.message).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : String(v)]));
  return { pk, key, fee, td, message };
}
const regMessage = (m: Record<string, string>) => ({ user: getAddress(m.user), key: getAddress(m.key), expiry: BigInt(m.expiry), feeAddress: getAddress(m.feeAddress), nonce: BigInt(m.nonce), deadline: BigInt(m.deadline) });
const noDeposit = (e: unknown) => (e as { code?: string }).code === 'noDeposit';

/** A brand-new wallet generated on this computer for one agent. */
export function createLocalWallet(label: string): WalletRecord {
  const pk = generatePrivateKey();
  const address = privateKeyToAccount(pk).address.toLowerCase();
  const rec: WalletRecord = { address, kind: 'local', label, createdAt: Date.now(), sealedWallet: seal(pk, address), keyStatus: 'none' };
  saveWallets([...loadWallets(), rec]);
  return rec;
}

/** Register the trade-only key for a LOCAL wallet: signed here with the wallet's own key, sent to Papertrade's API. */
export async function registerLocalKey(address: string, builderAddress: string): Promise<{ registered: boolean; reason?: string }> {
  const w = findWallet(address);
  if (!w || w.kind !== 'local' || !w.sealedWallet) throw new Error('not a local wallet');
  if (w.keyStatus === 'active' && (w.keyExpiry ?? 0) * 1000 > Date.now() + 86_400_000) return { registered: true };
  const r = newKeyRequest(address, builderAddress);
  const owner = privateKeyToAccount(open(w.sealedWallet, w.address) as Hex);
  const sig = await owner.signTypedData({ domain: DOMAIN, types: { RegisterSessionKey: TYPES.RegisterSessionKey }, primaryType: 'RegisterSessionKey', message: r.td.message });
  try {
    await submitRegistration(r.td.message, sig);
  } catch (e) {
    if (noDeposit(e)) return { registered: false, reason: 'waiting for the first deposit (Papertrade only accepts a key once the wallet is funded)' };
    throw e;
  }
  updateWallet(address, { key: r.key, sealedKey: seal(r.pk, r.key.toLowerCase()), keyExpiry: Number(r.td.message.expiry), feeAddress: r.fee, keyStatus: 'active' });
  return { registered: true };
}

/** External wallet (e.g. MetaMask), step 1: a fresh session key here and the typed data the wallet signs in the browser. */
export function startExternalKey(address: string, builderAddress: string, label: string) {
  const a = address.toLowerCase();
  const r = newKeyRequest(a, builderAddress);
  const existing = findWallet(a);
  if (existing?.agentId) throw new Error(`this wallet already belongs to agent ${existing.agentId}: one agent per wallet`);
  const rec: WalletRecord = { ...(existing ?? { address: a, kind: 'external', label, createdAt: Date.now(), keyStatus: 'none' }), key: r.key, sealedKey: seal(r.pk, r.key.toLowerCase()), keyExpiry: Number(r.td.message.expiry), feeAddress: r.fee, keyStatus: 'pending', pendingMessage: r.message };
  saveWallets([...loadWallets().filter((w) => w.address !== a), rec]);
  return {
    typedData: {
      domain: DOMAIN,
      types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], RegisterSessionKey: TYPES.RegisterSessionKey },
      primaryType: 'RegisterSessionKey', message: r.message,
    },
  };
}

/** External wallet, step 2: verify the signature here, then register through Papertrade's API. */
export async function confirmExternalKey(address: string, signature: Hex) {
  const w = findWallet(address);
  if (!w?.pendingMessage || w.keyStatus !== 'pending') throw new Error('no pending key for this wallet: start again');
  const message = regMessage(w.pendingMessage);
  if (Number(message.deadline) * 1000 < Date.now()) throw new Error('this signature request expired (1 hour); start again');
  const signer = await recoverTypedDataAddress({ domain: DOMAIN, types: { RegisterSessionKey: TYPES.RegisterSessionKey }, primaryType: 'RegisterSessionKey', message, signature });
  if (signer.toLowerCase() !== w.address) throw new Error(`signed by ${signer}, but you are connecting ${w.address}: switch to that account in your wallet`);
  try {
    await submitRegistration(message, signature);
  } catch (e) {
    if (noDeposit(e)) throw Object.assign(new Error('Papertrade only accepts the key once this wallet has a deposit. Deposit to its Papertrade address first, then sign again.'), { code: 'noDeposit' });
    throw e;
  }
  return updateWallet(address, { keyStatus: 'active', pendingMessage: undefined });
}

/** Proof for PaperQuants that a wallet belongs to the signed-in master account (local wallets sign it themselves). */
export const linkMessage = (master: string, wallet: string, ts: number) => `PaperQuants\nAction: link agent wallet\nMaster:${master.toLowerCase()}\nWallet:${wallet.toLowerCase()}\nTimestamp:${ts}`;
export async function signLinkLocal(address: string, master: string) {
  const w = findWallet(address);
  if (!w?.sealedWallet) throw new Error('not a local wallet');
  const ts = Date.now();
  const sig = await privateKeyToAccount(open(w.sealedWallet, w.address) as Hex).signMessage({ message: linkMessage(master, w.address, ts) });
  return { ts, sig };
}

/** The private key of a LOCAL wallet, for importing it into MetaMask/Rabby. Only on the user's explicit request. */
export function exportLocalKey(address: string): Hex {
  const w = findWallet(address);
  if (!w?.sealedWallet) throw new Error('only wallets generated on this computer can be exported');
  return open(w.sealedWallet, w.address) as Hex;
}

/** LOCAL wallets: move USDC out of Papertrade to the wallet's Hyperliquid account, then send it to the master wallet. */
export async function sweepLocal(address: string, to: string, amountUsd: number): Promise<{ withdrawn: boolean; sent?: unknown }> {
  const w = findWallet(address);
  if (!w?.sealedWallet) throw new Error('only wallets generated on this computer can be swept by the engine');
  const owner = privateKeyToAccount(open(w.sealedWallet, w.address) as Hex);
  const msg = { user: getAddress(w.address), amount: marginToSize(amountUsd), nonce: freshNonce(), deadline: deadline() };
  const sig = await owner.signTypedData({ domain: DOMAIN, types: { WithdrawToCore: TYPES.WithdrawToCore }, primaryType: 'WithdrawToCore', message: msg });
  await submitIntent('withdrawToCore', { ...serialize('WithdrawToCore', msg), ...splitSig(sig) });
  // Hyperliquid usdSend from the agent wallet to the master (user-signed action, HyperliquidSignTransaction domain).
  const time = Date.now();
  const action = { type: 'usdSend', hyperliquidChain: 'Mainnet', signatureChainId: '0xa4b1', destination: getAddress(to), amount: amountUsd.toFixed(2), time };
  const hsig = await owner.signTypedData({
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: 0xa4b1, verifyingContract: '0x0000000000000000000000000000000000000000' },
    types: { 'HyperliquidTransaction:UsdSend': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }] },
    primaryType: 'HyperliquidTransaction:UsdSend', message: { hyperliquidChain: 'Mainnet', destination: action.destination, amount: action.amount, time: BigInt(time) },
  });
  const r = await fetch('https://api.hyperliquid.xyz/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, nonce: time, signature: { r: hsig.slice(0, 66), s: '0x' + hsig.slice(66, 130), v: parseInt(hsig.slice(130, 132), 16) } }), signal: AbortSignal.timeout(20_000) });
  return { withdrawn: true, sent: await r.json().catch(() => ({ status: r.status })) };
}

export class PapertradeAdapter implements VenueAdapter {
  readonly venue = 'papertrade';
  readonly address: Address;
  constructor(address: string) { this.address = getAddress(address); }
  limits(): VenueLimits { return { maxLeverage: 1000, minMarginUsd: 1, coins: ['BTC', 'ETH'], nativeExits: false }; }
  private rec() { return findWallet(this.address); }
  ready(): boolean {
    const w = this.rec();
    return !!w && w.keyStatus === 'active' && (w.keyExpiry ?? 0) * 1000 > Date.now() + 5 * 60_000;
  }
  private signer(): Hex {
    const w = this.rec();
    if (!w?.sealedKey || w.keyStatus !== 'active') throw new Error(`wallet ${this.address} has no active trading key yet`);
    if ((w.keyExpiry ?? 0) * 1000 < Date.now() + 5 * 60_000) throw new Error('the trading key expired (30 days): reconnect this wallet');
    return open(w.sealedKey, w.key!.toLowerCase()) as Hex;
  }
  snapshot() { return walletSnapshot(this.address); }
  async open(coin: string, side: 'long' | 'short', marginUsd: number, leverage: number) {
    const { signed, intentId } = await signWithSessionKey('OpenPosition', this.signer(), openMessage(this.address, coin, side === 'long', marginUsd, Math.round(leverage)));
    await submitIntent('openPosition', signed);
    return { intentId };
  }
  async close(positionIds: string[]) {
    const pk = this.signer();
    for (let i = 0; i < positionIds.length; i += 12) {
      const { signed } = await signWithSessionKey('Close', pk, closeMessage(this.address, positionIds.slice(i, i + 12)));
      await submitIntent('closePositions', signed).catch((e) => { if ((e as { code?: string }).code !== 'noOpenPositions') throw e; });
    }
  }
  depositAddress() { return depositAddress(this.address); }
  trades() { return closedTrades(this.address); }
}

export type { WalletSnapshot, LivePosition };
