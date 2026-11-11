import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { effectivePlan } from '../src/plans.js';

test('seed is idempotent, demo runs on Business, demo users get no emails', () => {
  const db = openDb();
  assert.deepEqual(seed(db), { created: true });
  const count = () => db.prepare('SELECT (SELECT COUNT(*) FROM posts) p, (SELECT COUNT(*) FROM votes) v, (SELECT COUNT(*) FROM users) u').get();
  const first = { ...count() };
  assert.deepEqual(seed(db), { created: false });
  assert.deepEqual({ ...count() }, first);
  const ws = db.prepare("SELECT * FROM workspaces WHERE slug = 'acme-cloud'").get();
  assert.equal(effectivePlan(ws), 'business');
  assert.equal(db.prepare('SELECT SUM(email_notifications) AS s FROM users').get().s, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_outbox').get().n, 0);

  // A demo workspace from before billing gets upgraded on re-seed.
  db.prepare("UPDATE workspaces SET plan = 'free' WHERE slug = 'acme-cloud'").run();
  seed(db);
  assert.equal(db.prepare("SELECT plan FROM workspaces WHERE slug = 'acme-cloud'").get().plan, 'business');
});
