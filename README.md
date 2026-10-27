# PaperQuants for Claude

Research, backtest and run 500–1000× BTC/ETH trading agents on **your own Papertrade account**, with your own Claude.

- **Non-custodial:** your money stays in your Papertrade account. We never hold funds or keys.
- **One wallet per agent:** every agent trades its own wallet, generated on your computer or one of your own (e.g. a MetaMask account). Budgets are never shared. Your main wallet is your PaperQuants account, and its agent wallets show on your account page at paperquants.com.
- **Trade-only keys, on your machine:** each agent wallet gets a Papertrade session key that can open and close trades, **cannot withdraw**, expires in 30 days, and is stored encrypted in `~/.paperquants`. See [SECURITY.md](SECURITY.md).
- **Your limits, enforced in code:** every agent has a max leverage, a capital cap, a max margin per trade, a max daily loss and a coin list, agreed with you before it starts. The engine refuses any order outside them. `kill_all` stops everything.
- **Open source:** read exactly what runs.

## Install
Claude Code:
```bash
claude mcp add paperquants -- npx -y paperquants mcp
```
Claude desktop app: install the PaperQuants extension (one click), or add the same command to your MCP config.

Claude desktop app (Settings → Developer → Edit Config):
```json
{ "mcpServers": { "paperquants": { "command": "npx", "args": ["-y", "paperquants", "mcp"] } } }
```

Then tell Claude: "Set me up with PaperQuants". You sign in with your wallet. Claude researches, proposes an agent, sets limits with you, and gives you the agent wallet's Papertrade deposit address (min 10 USDC on HyperCore).

## Develop
```bash
npm install && npm run build && claude mcp add paperquants -- node $(pwd)/dist/cli.js mcp
```
`core/` is the trading core shared with the PaperQuants server: Papertrade payout and liquidation math, the strategy sandbox, risk checks, intent signing and key encryption.

## How it works
- `paperquants mcp`: the tools Claude uses (market data, the PaperQuants research brain, 1-second backtests, agents, limits, publishing research).
- `paperquants engine`: a small background process (started automatically) that runs each agent's strategy every second on live Hyperliquid prices and places your trades on Papertrade.
- Papertrade has no take-profit/stop-loss orders: the engine closes trades. Your computer must stay on while trades are open. The engine prevents sleep automatically; pause agents before you shut down.

## Risk
At 500–1000× leverage a move of 0.05–0.2% liquidates a position. You can lose all the money you give an agent. Start small.
