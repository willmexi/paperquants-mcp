// The MCP side's handle on the local engine: starts it in the background if it isn't running, then calls its API.
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { ENGINE_PORT, engineToken, file } from './home.ts';

const base = `http://127.0.0.1:${ENGINE_PORT}`;

async function ping(): Promise<boolean> {
  try {
    const r = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${engineToken()}` }, signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

export async function ensureEngine(): Promise<void> {
  if (await ping()) return;
  const log = openSync(file('engine.log'), 'a');
  const child = spawn(process.execPath, [process.argv[1], 'engine'], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await ping()) return;
  }
  throw new Error(`the local engine did not start; see ${file('engine.log')}`);
}

export async function engine<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  await ensureEngine();
  const r = await fetch(base + path, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${engineToken()}` },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `engine HTTP ${r.status}`);
  return data as T;
}

export const connectUrl = (mode: 'login' | 'wallet', label = '') => `${base}/connect?t=${engineToken()}&mode=${mode}${label ? `&label=${encodeURIComponent(label)}` : ''}`;
