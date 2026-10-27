// The MCP side's handle on the local engine: starts it in the background if it isn't running, then calls its API.
import { spawn, execFileSync } from 'node:child_process';
import { openSync } from 'node:fs';
import { ENGINE_PORT, engineToken, file, BUILD } from './home.ts';

const base = `http://127.0.0.1:${ENGINE_PORT}`;

async function status(): Promise<{ build?: string } | null> {
  try {
    const r = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${engineToken()}` }, signal: AbortSignal.timeout(1500) });
    return r.ok ? r.json() : null;
  } catch { return null; }
}
const ping = async () => !!(await status());
let checked = false;

export async function ensureEngine(): Promise<void> {
  const st = await status();
  if (st && (checked || st.build === BUILD || BUILD === 'dev')) return;
  if (st) {
    // An engine from an older build is running: replace it (agents and positions are saved and resume).
    await fetch(`${base}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${engineToken()}` } }).catch(() => {});
    for (let i = 0; i < 20 && (await ping()); i++) await new Promise((r) => setTimeout(r, 250));
    // Engines older than /shutdown: stop the process holding our port (SIGTERM saves state first).
    if (await ping()) {
      try {
        const pids = execFileSync('lsof', ['-ti', `tcp:${ENGINE_PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number);
        for (const pid of pids) if (pid !== process.pid) process.kill(pid, 'SIGTERM');
      } catch { /* no lsof: keep the running engine */ }
      for (let i = 0; i < 20 && (await ping()); i++) await new Promise((r) => setTimeout(r, 250));
    }
  }
  checked = true;
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
