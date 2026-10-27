// paperquants: one binary for the MCP server (`mcp`, what Claude runs), the local trading engine (`engine`, started
// automatically), and `connect` / `status` for humans in a terminal.
import './home.ts'; // must stay first: sets the data dir before the vault module loads
import { VERSION, ENGINE_PORT } from './home.ts';

const cmd = process.argv[2] ?? 'help';

if (cmd === 'mcp') {
  const { runMcp } = await import('./mcp.ts');
  await runMcp();
} else if (cmd === 'engine') {
  const { Engine } = await import('./engine/engine.ts');
  const { serve } = await import('./engine/http.ts');
  const e = new Engine();
  serve(e); // answer right away; the engine finishes starting in the background
  await e.start();
  console.error(`[paperquants] engine ${VERSION} on 127.0.0.1:${ENGINE_PORT}`);
  const stop = () => { e.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else if (cmd === 'connect' || cmd === 'status') {
  const { engine, connectUrl } = await import('./local.ts');
  if (cmd === 'connect') console.log(`Open this in a browser with your wallet:\n${(await engine('/status'), connectUrl('login'))}`);
  else console.log(JSON.stringify(await engine('/status'), null, 1));
} else {
  console.log(`paperquants ${VERSION}
  paperquants mcp       MCP server for Claude (Claude Code: claude mcp add paperquants -- npx -y paperquants mcp)
  paperquants engine    run the local trading engine in the foreground (normally started automatically)
  paperquants connect   print the local sign-in page for your PaperQuants account
  paperquants status    engine, connection and agents`);
}
