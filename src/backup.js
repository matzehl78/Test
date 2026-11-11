// Online, consistent SQLite backup via VACUUM INTO; keeps the newest N files.
// Usage: node src/backup.js            (env: DB_FILE, BACKUP_DIR, BACKUP_KEEP)
import { mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';

export function backup(db, dir, keep = 14, now = new Date()) {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `pulseboard-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = readdirSync(dir)
    .filter((f) => /^pulseboard-.*\.db$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) unlinkSync(join(dir, f));
  return { file, bytes: statSync(file).size, removed: old.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dbFile = process.env.DB_FILE || join(root, 'data', 'pulseboard.db');
  const dir = process.env.BACKUP_DIR || join(dirname(dbFile), 'backups');
  const keep = Number(process.env.BACKUP_KEEP) || 14;
  const db = openDb(dbFile);
  const r = backup(db, dir, keep);
  db.close();
  console.log(`[backup] ${r.file} (${(r.bytes / 1024).toFixed(1)} KiB), ${r.removed} alte entfernt`);
}
