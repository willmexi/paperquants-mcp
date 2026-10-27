// Client for the PaperQuants server (/api/net/*). The login token is stored locally (0600) after the wallet signs in.
import { API_URL, readJson, writeJson, VERSION } from './home.ts';

export interface Session { wallet: string; token: string; at: number }
export const session = () => readJson<Session | null>('session.json', null);
export const saveSession = (s: Session) => writeJson('session.json', s);

/** The exact text the wallet signs to log in (the server verifies it with a 5-minute window). */
export const loginMessage = (wallet: string, ts: number) => `PaperQuants\nAction: login\nWallet:${wallet.toLowerCase()}\nTimestamp:${ts}`;

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-paperquants-version': VERSION };
  if (opts.auth) {
    const s = session();
    if (!s) throw new Error('not signed in: run sign_in first');
    headers.authorization = `Bearer ${s.token}`;
  }
  const r = await fetch(API_URL + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'), headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  const text = await r.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status} on ${path}`);
  return data as T;
}

export interface NetConfig { builderAddress: string; minVersion?: string }
export const netConfig = () => api<NetConfig>('/api/net/config').catch(() => ({ builderAddress: '' }) as NetConfig);
