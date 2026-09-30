import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { openDb } from './db';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const dataDir = path.resolve(repoRoot, process.env.DATA_DIR ?? 'data');

const db = openDb(path.join(dataDir, 'dnd-table.db'));
const app = await buildApp({
  db,
  webDist: production ? path.join(repoRoot, 'apps/web/dist') : undefined,
  signupCode: process.env.SIGNUP_CODE || undefined,
  secureCookies: process.env.COOKIE_SECURE === 'true',
  logger: process.env.LOG_REQUESTS === 'true',
});

await app.listen({ port, host });

// In dev the browser talks to Vite (5173), which proxies API and WebSocket calls here.
const webPort = production ? port : 5173;
const lan = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => `http://${i!.address}:${webPort}`);
console.log(`\n  dnd-table server listening on ${host}:${port} (data: ${dataDir})`);
console.log(`  Open on this computer:  http://localhost:${webPort}`);
for (const url of lan) console.log(`  Open on your network:   ${url}`);
console.log('');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
