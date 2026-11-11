import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clientIp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { backup } from '../src/backup.js';

const req = (xff, remote = '172.18.0.3') => ({
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  socket: { remoteAddress: remote },
});

test('clientIp: without trustProxy the socket address is used, XFF ignored', () => {
  assert.equal(clientIp(req('1.2.3.4')), '172.18.0.3');
});

test('clientIp: trustProxy=1 takes the right-most XFF entry (spoofed left entries ignored)', () => {
  assert.equal(clientIp(req('6.6.6.6, 203.0.113.9'), 1), '203.0.113.9');
  assert.equal(clientIp(req('203.0.113.9'), 1), '203.0.113.9');
});

test('clientIp: trustProxy=2 skips one more hop; short chain falls back to socket', () => {
  assert.equal(clientIp(req('6.6.6.6, 198.51.100.1, 10.0.0.2'), 2), '198.51.100.1');
  assert.equal(clientIp(req('198.51.100.1'), 2), '172.18.0.3');
  assert.equal(clientIp(req(undefined), 1), '172.18.0.3');
});

test('backup: consistent copy via VACUUM INTO, rotation keeps newest N', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-backup-'));
  try {
    const db = openDb(join(dir, 'live.db'));
    db.prepare("INSERT INTO users (email, name, password_hash) VALUES ('a@b.de', 'A', 'x')").run();
    const out = join(dir, 'backups');
    for (let i = 0; i < 4; i++) backup(db, out, 2, new Date(Date.UTC(2026, 0, 1 + i)));
    const files = readdirSync(out).sort();
    assert.deepEqual(files, ['pulseboard-2026-01-03T00-00-00-000Z.db', 'pulseboard-2026-01-04T00-00-00-000Z.db']);
    const copy = new DatabaseSync(join(out, files[1]), { readOnly: true });
    assert.equal(copy.prepare('SELECT email FROM users').get().email, 'a@b.de');
    assert.equal(copy.prepare('PRAGMA user_version').get().user_version, db.prepare('PRAGMA user_version').get().user_version);
    copy.close();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
