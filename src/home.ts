// Where the local install keeps its state (~/.paperquants, or PAPERQUANTS_HOME). Imported first by the CLI so the
// shared vault seals keys with a master key that lives here, never in the repo or on our server.
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const HOME = process.env.PAPERQUANTS_HOME ?? join(homedir(), '.paperquants');
mkdirSync(HOME, { recursive: true, mode: 0o700 });
process.env.PQ_DATA_DIR = HOME;

/** Our server (data, backtests, research inbox, leaderboard). */
export const API_URL = (process.env.PAPERQUANTS_API ?? 'https://paperquants.com').replace(/\/$/, '');
/** The local engine's control port (127.0.0.1 only). */
export const ENGINE_PORT = Number(process.env.PAPERQUANTS_PORT ?? 47321);
export const VERSION = '0.1.0';

export const file = (name: string) => join(HOME, name);

export function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic-enough write with owner-only permissions (these files hold sealed keys and the login token). */
export function writeJson(name: string, value: unknown): void {
  const p = file(name);
  writeFileSync(p + '.tmp', JSON.stringify(value, null, 1), { mode: 0o600 });
  writeFileSync(p, readFileSync(p + '.tmp'), { mode: 0o600 });
  chmodSync(p, 0o600);
}

/** Shared secret between the MCP process and the engine's local HTTP API. */
export function engineToken(): string {
  const p = file('engine.token');
  if (!existsSync(p)) writeFileSync(p, randomBytes(24).toString('hex'), { mode: 0o600 });
  return readFileSync(p, 'utf8').trim();
}
