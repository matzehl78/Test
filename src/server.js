import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || join(root, 'data', 'pulseboard.db');

const db = openDb(DB_FILE);
const app = createApp({
  db,
  publicDir: join(root, 'public'),
  secureCookies: process.env.NODE_ENV === 'production',
});

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`Pulseboard läuft auf http://localhost:${PORT}  (DB: ${DB_FILE})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
