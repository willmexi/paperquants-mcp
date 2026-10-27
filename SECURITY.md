# Security model

Claims below are meant to be checked against the code. Ask your Claude to verify them: "read the paperquants package and confirm SECURITY.md".

**Your money**
- PaperQuants never holds your funds. Each agent trades its own wallet's Papertrade account.

**Keys**
- **Trading keys** (`core/live/papertrade.ts` `registrationTypedData`, `src/engine/adapter.ts`):
  - each agent wallet gets a Papertrade *session key* that can only `OpenPosition` and `Close`;
  - withdrawing (`WithdrawToCore`) needs the wallet's own signature, so a session key cannot move funds out;
  - keys expire after 30 days, and you can revoke them in Papertrade.
- **Wallets generated on your computer** (`createLocalWallet`):
  - the wallet key is created locally, sealed with AES-256-GCM (`core/live/vault.ts`), and stored in `~/.paperquants/wallets.json` (mode 0600) under a master key in `~/.paperquants/master.key` (0600);
  - it is only used to sign this wallet's Papertrade key registration, its link to your account, and the withdrawals you ask for (`sweep_wallet`);
  - `export_wallet_key` shows it only on your explicit request.
- **No key is ever sent anywhere.** Only signatures go to Papertrade's API, and signed link proofs go to PaperQuants.

**Network**
- The engine talks to exactly these hosts:
  - `api.hyperliquid.xyz`: prices, candles, funding, and the `usdSend` you request in a sweep;
  - `exchange.papertrade.xyz` (and `rpc.hyperliquid.xyz` for the deposit address): trading intents, your account state, your trade history;
  - `paperquants.com` (override with `PAPERQUANTS_API`): sign-in, agent registry, research, backtests.
- The control API listens on `127.0.0.1` only (`src/engine/http.ts`) and requires the token in `~/.paperquants/engine.token`.

**What PaperQuants (the server) learns**
- Your master wallet address and your agent wallets' public addresses (with proof you own them).
- Each agent's name, strategy code, params and limits, plus a heartbeat (equity, open positions, status).
- Your trades are read from Papertrade's public history.

**Limits are enforced in code, not by Claude**
- `src/engine/engine.ts` `guard()` checks every order: coins, venue, max leverage, max margin per trade (`checkOrder`), and the DEGEN floor if chosen.
- A daily loss limit pauses the agent and closes its positions.
- `kill_all` closes everything the engine opened and blocks new orders.
- `create_agent` refuses without `user_approved: true`, and every agent needs its own wallet.

**Strategy code**
- Runs in a Node `vm` context (`core/sandbox.ts`): no `require`, no network, no file system, string/wasm code generation disabled, 50 ms per tick.
- It only returns order intents, which pass the guard above.
- `vm` is not a hard security boundary: only run strategy code you or your Claude have read.

**Reporting a vulnerability:** open a GitHub security advisory on this repo.
