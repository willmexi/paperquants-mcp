// Encryption at rest for the session keys we hold. AES-256-GCM with a master key that never enters the database:
// PQ_MASTER_KEY (hex, 32 bytes) in production (from Secret Manager / Cloud KMS), or data/master.key (0600) locally.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';

// PQ_DATA_DIR moves it (the local engine keeps it in ~/.paperquants).
const DIR = process.env.PQ_DATA_DIR ? new URL(`file://${process.env.PQ_DATA_DIR.replace(/\/?$/, '/')}`) : new URL('../../data/', import.meta.url);
const FILE = new URL('master.key', DIR);
let cached: Buffer | undefined;

function masterKey(): Buffer {
  if (cached) return cached;
  const env = process.env.PQ_MASTER_KEY;
  if (env) {
    cached = Buffer.from(env, 'hex');
  } else {
    if (!existsSync(FILE)) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(FILE, randomBytes(32).toString('hex'), { mode: 0o600 });
      chmodSync(FILE, 0o600);
    }
    cached = Buffer.from(readFileSync(FILE, 'utf8').trim(), 'hex');
  }
  if (cached.length !== 32) throw new Error('master key must be 32 bytes (64 hex chars)');
  return cached;
}

/** "v1:<iv>:<tag>:<ciphertext>" (hex). `aad` binds the ciphertext to its owner (e.g. the key address). */
export function seal(plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey(), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${ct.toString('hex')}`;
}

export function open(sealed: string, aad: string): string {
  const [v, iv, tag, ct] = sealed.split(':');
  if (v !== 'v1') throw new Error('unknown sealed format');
  const d = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'hex'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(ct, 'hex')), d.final()]).toString('utf8');
}
