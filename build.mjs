// Bundles the CLI (MCP server + local engine + connect page) and the shared trading core from ../src into one file.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  external: ['@modelcontextprotocol/sdk', 'viem', 'zod'],
  define: { __BUILD__: JSON.stringify(new Date().toISOString()) },
  logLevel: 'info',
});
