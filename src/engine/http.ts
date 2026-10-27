// The engine's control API on 127.0.0.1 only. The MCP tools call it with the token in ~/.paperquants/engine.token;
// the connect page (opened in the user's browser) gets the same token in its URL.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { verifyMessage, type Hex } from 'viem';
import { ENGINE_PORT, engineToken, VERSION, BUILD, API_URL } from '../home.ts';
import { api, loginMessage, netConfig, saveSession, session } from '../net.ts';
import { connectPage } from './connectPage.ts';
import { createLocalWallet, startExternalKey, confirmExternalKey, findWallet, updateWallet, exportLocalKey, sweepLocal, linkMessage, PapertradeAdapter } from './adapter.ts';
import type { Engine } from './engine.ts';

async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1_000_000) throw new Error('body too large'); }
  return s ? JSON.parse(s) : {};
}
const accountUrl = (master: string) => `${API_URL}/account/${master}`;

export function serve(engine: Engine) {
  const token = engineToken();
  const server = createServer(async (req, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${ENGINE_PORT}`);
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (req.method === 'GET' && url.pathname === '/connect') {
        if (url.searchParams.get('t') !== token) return send(403, { error: 'bad token' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(connectPage(token, url.searchParams.get('mode') === 'wallet' ? 'wallet' : 'login', url.searchParams.get('label') ?? ''));
      }
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
      const m = `${req.method} ${url.pathname}`;
      const b = req.method === 'GET' ? {} : await body(req);
      let id: string | undefined;
      if (m === 'GET /status') return send(200, { version: VERSION, build: BUILD, accountPage: session() ? accountUrl(session()!.wallet) : null, ...engine.status() });
      if (m === 'GET /agents') return send(200, engine.list());
      if (m === 'POST /agents') return send(200, await engine.createAgent(b));
      if ((id = url.pathname.match(/^\/agents\/([\w-]+)$/)?.[1]) && req.method === 'GET') return send(200, engine.describe(id));
      if ((id = url.pathname.match(/^\/agents\/([\w-]+)\/limits$/)?.[1]) && req.method === 'POST') return send(200, engine.updateLimits(id, b));
      if ((id = url.pathname.match(/^\/agents\/([\w-]+)\/status$/)?.[1]) && req.method === 'POST') return send(200, engine.setStatus(id, b.status));
      if ((id = url.pathname.match(/^\/agents\/([\w-]+)\/live$/)?.[1]) && req.method === 'POST') return send(200, engine.goLive(id, b.wallet, b.userApproved, b.capitalUsd));
      if (m === 'POST /kill') return send(200, engine.setKill(!!b.on));
      if (m === 'POST /shutdown') { send(200, { ok: true }); engine.stop(); setTimeout(() => process.exit(0), 200); return; }
      if (m === 'GET /config') return send(200, engine.config);
      if (m === 'POST /config') return send(200, engine.setConfig(b));

      // ---- agent wallets (one per agent) ----
      if (m === 'GET /wallets') return send(200, engine.wallets());
      if (m === 'POST /wallets/local') {
        const w = createLocalWallet(String(b.label ?? 'agent wallet').slice(0, 60));
        const linked = await engine.linkLocal(w.address).catch(() => false);
        const dep = await new PapertradeAdapter(w.address).depositAddress().catch(() => null);
        return send(200, { address: w.address, kind: 'local', linkedToAccount: linked, papertradeDepositAddress: dep, next: 'Deposit USDC to papertradeDepositAddress (HyperCore). The engine registers the trading key by itself once the deposit lands.' });
      }
      if ((id = url.pathname.match(/^\/wallets\/(0x[0-9a-fA-F]{40})\/deposit$/)?.[1]) && req.method === 'GET') return send(200, { wallet: id.toLowerCase(), papertradeDepositAddress: await new PapertradeAdapter(id).depositAddress() });
      if ((id = url.pathname.match(/^\/wallets\/(0x[0-9a-fA-F]{40})\/export$/)?.[1]) && req.method === 'POST') {
        if (b.confirm !== true) return send(400, { error: 'export needs confirm:true (the user must ask for it explicitly)' });
        return send(200, { address: id.toLowerCase(), privateKey: exportLocalKey(id), warning: 'Anyone with this key controls the wallet. Import it into MetaMask/Rabby, never share it.' });
      }
      if ((id = url.pathname.match(/^\/wallets\/(0x[0-9a-fA-F]{40})\/sweep$/)?.[1]) && req.method === 'POST') {
        const master = session()?.wallet;
        if (!master) return send(400, { error: 'sign in with your master wallet first' });
        const w = findWallet(id);
        if (w?.agentId && engine.live.get(w.agentId)?.rec.status === 'running') return send(400, { error: `pause agent ${w.agentId} first` });
        return send(200, await sweepLocal(id, master, Number(b.amountUsd)));
      }
      if (m === 'GET /account') return send(200, { masterAccount: session()?.wallet ?? null, page: session() ? accountUrl(session()!.wallet) : null });

      // ---- connect page: master sign-in, and connecting an external agent wallet ----
      if (m === 'POST /connect/login') {
        const { wallet, ts, sig } = b as { wallet: string; ts: number; sig: Hex };
        if (!(await verifyMessage({ address: wallet as Hex, message: loginMessage(wallet, ts), signature: sig }))) return send(400, { error: 'signature does not match the wallet' });
        const r = await api<{ token: string }>('/api/net/login', { body: { wallet: wallet.toLowerCase(), ts, sig } }).catch((e) => ({ token: '', error: (e as Error).message }));
        if (!r.token) return send(400, { error: `PaperQuants sign-in failed: ${(r as { error?: string }).error}` });
        saveSession({ wallet: wallet.toLowerCase(), token: r.token, at: Date.now() });
        for (const w of engine.wallets()) if (w.kind === 'local') await engine.linkLocal(w.address).catch(() => {});
        return send(200, { signedIn: true, accountPage: accountUrl(wallet.toLowerCase()) });
      }
      if (m === 'POST /connect/link-message') {
        const s = session();
        if (!s) return send(400, { error: 'sign in with your master wallet first' });
        const ts = Date.now();
        return send(200, { ts, message: linkMessage(s.wallet, b.wallet, ts) });
      }
      if (m === 'POST /connect/wallet/start') {
        const s = session();
        if (!s) return send(400, { error: 'sign in with your master wallet first' });
        const { wallet, ts, sig, label } = b as { wallet: string; ts: number; sig: Hex; label?: string };
        if (!(await verifyMessage({ address: wallet as Hex, message: linkMessage(s.wallet, wallet, ts), signature: sig }))) return send(400, { error: 'link signature does not match the wallet' });
        const start = startExternalKey(wallet, (await netConfig()).builderAddress, String(label ?? 'agent wallet').slice(0, 60));
        await api('/api/net/wallets', { auth: true, body: { address: wallet.toLowerCase(), kind: 'external', label, ts, sig } }).then(() => updateWallet(wallet, { linked: true })).catch(() => {});
        return send(200, start);
      }
      if (m === 'POST /connect/wallet/confirm') {
        try {
          const w = await confirmExternalKey(b.wallet, b.sig);
          return send(200, { wallet: w.address, tradingKey: w.keyStatus });
        } catch (e) {
          const code = (e as { code?: string }).code;
          const dep = code === 'noDeposit' ? await new PapertradeAdapter(b.wallet).depositAddress().catch(() => null) : null;
          return send(400, { error: (e as Error).message, code, depositAddress: dep });
        }
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(400, { error: (e as Error).message });
    }
  });
  server.listen(ENGINE_PORT, '127.0.0.1');
  return server;
}
