import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { signPayload } from '../src/stripe.js';
import {
  createMailer, processOutbox, enqueueEmail, getAppSecret,
  unsubscribeToken, checkUnsubscribeToken, escapeHtml,
} from '../src/mail.js';

const APP_URL = 'https://pb.example';
const WH = 'whsec_mail';

let s;
before(async () => {
  const db = openDb();
  const srv = createServer(createApp({
    db, authRateLimit: 1000, appUrl: APP_URL, secret: 'test-secret',
    billing: { webhookSecret: WH, prices: { pro: 'price_pro' } },
  }));
  await new Promise((r) => srv.listen(0, r));
  s = { db, srv, base: `http://localhost:${srv.address().port}` };
});
after(() => s.srv.close());

function client(base) {
  let jar = '';
  return async (method, path, body, headers = {}) => {
    const h = { cookie: jar, ...headers };
    if (method !== 'GET' && !('content-type' in h)) h['content-type'] = 'application/json';
    const res = await fetch(base + path, {
      method, headers: h,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) jar = sc.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, body: json, text };
  };
}

let n = 0;
async function user(name) {
  const c = client(s.base);
  c.email = `m${++n}@example.com`;
  c.displayName = name ?? `User ${n}`;
  assert.equal((await c('POST', '/api/auth/signup', { email: c.email, name: c.displayName, password: 'password123' })).status, 201);
  return c;
}

async function setup() {
  const owner = await user('Olga Owner');
  const slug = `mail-${++n}`;
  assert.equal((await owner('POST', '/api/workspaces', { name: `Mail ${n}`, slug })).status, 201);
  const ws = (await owner('GET', `/api/w/${slug}`)).body;
  const post = async (c, title) => {
    const r = await c('POST', `/api/w/${slug}/posts`, { boardId: ws.boards[0].id, title });
    assert.equal(r.status, 201, r.text);
    return r.body.post;
  };
  return { owner, slug, ws, post };
}

/** All outbox rows created after the given mark (an outbox id). */
const mark = () => s.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM email_outbox').get().m;
const mailsSince = (m, kind) => s.db.prepare(
  `SELECT * FROM email_outbox WHERE id > ? ${kind ? 'AND kind = ?' : ''} ORDER BY id`,
).all(...(kind ? [m, kind] : [m]));
const recipients = (rows) => rows.map((r) => r.to_email).sort();

describe('notification fan-out', () => {
  test('status change → author, voters, commenters; not actor, not opted-out', async () => {
    const { owner, slug, post } = await setup();
    const author = await user();
    const voter = await user();
    const commenter = await user();
    const optedOut = await user();
    const p = await post(author, 'Dark mode');
    await voter('POST', `/api/w/${slug}/posts/${p.id}/vote`);
    await owner('POST', `/api/w/${slug}/posts/${p.id}/vote`); // actor votes too → still excluded
    await commenter('POST', `/api/w/${slug}/posts/${p.id}/comments`, { body: '+1' });
    await optedOut('POST', `/api/w/${slug}/posts/${p.id}/vote`);
    assert.equal((await optedOut('PATCH', '/api/me', { emailNotifications: false })).status, 200);

    const m = mark();
    assert.equal((await owner('PATCH', `/api/w/${slug}/posts/${p.id}`, { status: 'planned' })).status, 200);
    const rows = mailsSince(m);
    assert.ok(rows.every((r) => r.kind === 'status_change'));
    assert.deepEqual(recipients(rows), [author.email, commenter.email, voter.email].sort());
    assert.equal(rows[0].status, 'pending');
    assert.match(rows[0].subject, /^Geplant: Dark mode/);
    assert.match(rows[0].text_body, /Offen → Geplant/);
    assert.ok(rows[0].text_body.includes(`${APP_URL}/${slug}/p/${p.id}`));

    // Editing without status change, or moving back to "open", sends nothing.
    const m2 = mark();
    await owner('PATCH', `/api/w/${slug}/posts/${p.id}`, { title: 'Dark mode v2' });
    await owner('PATCH', `/api/w/${slug}/posts/${p.id}`, { status: 'open' });
    assert.equal(mailsSince(m2).length, 0);
  });

  test('admin comment notifies subscribers, non-admin comment does not', async () => {
    const { owner, slug, post } = await setup();
    const author = await user();
    const voter = await user();
    const p = await post(author, 'Slack integration');
    await voter('POST', `/api/w/${slug}/posts/${p.id}/vote`);

    let m = mark();
    await voter('POST', `/api/w/${slug}/posts/${p.id}/comments`, { body: 'me too' });
    assert.equal(mailsSince(m).length, 0);

    m = mark();
    await owner('POST', `/api/w/${slug}/posts/${p.id}/comments`, { body: 'We are on it' });
    const rows = mailsSince(m);
    assert.ok(rows.every((r) => r.kind === 'admin_comment'));
    assert.deepEqual(recipients(rows), [author.email, voter.email].sort());
    assert.ok(rows[0].text_body.includes('We are on it'));
    assert.ok(rows[0].text_body.includes('Olga Owner'));
  });

  test('changelog → one digest per user, no extra status_change mails', async () => {
    const { owner, slug, post } = await setup();
    const fan = await user();
    const other = await user();
    const a = await post(fan, 'Export to PDF');
    const b = await post(fan, 'Export to Excel');
    await other('POST', `/api/w/${slug}/posts/${b.id}/vote`);
    await owner('PATCH', `/api/w/${slug}/posts/${a.id}`, { status: 'in_progress' });

    const m = mark();
    const r = await owner('POST', `/api/w/${slug}/changelog`, { title: 'Release 2.0', body: 'Exports!', postIds: [a.id, b.id] });
    assert.equal(r.status, 201);
    const rows = mailsSince(m);
    assert.equal(mailsSince(m, 'status_change').length, 0);
    assert.ok(rows.every((x) => x.kind === 'changelog'));
    assert.deepEqual(recipients(rows), [fan.email, other.email].sort());
    const fanMail = rows.find((x) => x.to_email === fan.email);
    assert.match(fanMail.subject, /^Ausgeliefert: Release 2\.0/);
    assert.match(fanMail.text_body, /2 Ideen/);
    assert.ok(fanMail.text_body.includes('Exports!'));
    assert.match(rows.find((x) => x.to_email === other.email).text_body, /„Export to Excel“/);
    // Posts are done anyway.
    assert.equal((await owner('GET', `/api/w/${slug}/posts/${a.id}`)).body.post.status, 'done');
  });

  test('changelog without linked posts sends nothing', async () => {
    const { owner, slug } = await setup();
    const m = mark();
    assert.equal((await owner('POST', `/api/w/${slug}/changelog`, { title: 'Infra only' })).status, 201);
    assert.equal(mailsSince(m).length, 0);
  });

  test('invoice.payment_failed → owner, even with notifications off', async () => {
    const { owner, slug } = await setup();
    await owner('PATCH', '/api/me', { emailNotifications: false });
    const { id } = s.db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug);
    const raw = JSON.stringify({
      id: `evt_pf_${id}`, type: 'invoice.payment_failed',
      data: { object: { object: 'invoice', customer: 'cus_x', subscription: 'sub_x', metadata: { workspace_id: String(id) } } },
    });
    const t = Math.floor(Date.now() / 1000);
    const m = mark();
    const res = await fetch(`${s.base}/api/stripe/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${signPayload(raw, WH, t)}` },
      body: raw,
    });
    assert.equal(res.status, 200);
    const rows = mailsSince(m);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'payment_failed');
    assert.equal(rows[0].to_email, owner.email);
    assert.ok(rows[0].text_body.includes(`${APP_URL}/${slug}/admin#billing`));
  });

  test('user content is HTML-escaped; headers carry one-click unsubscribe', async () => {
    const { owner, slug, post } = await setup();
    const author = await user('<img src=x onerror=alert(1)>');
    const p = await post(author, '<script>alert("x")</script> & more');
    const m = mark();
    await owner('POST', `/api/w/${slug}/posts/${p.id}/comments`, { body: '<b>bold</b> "quoted"' });
    const [row] = mailsSince(m);
    assert.ok(!row.html_body.includes('<script>'));
    assert.ok(!row.html_body.includes('<b>bold'));
    assert.ok(!row.html_body.includes('<img'));
    assert.ok(row.html_body.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more'));
    assert.ok(row.html_body.includes('&lt;b&gt;bold&lt;/b&gt;'));
    const h = JSON.parse(row.headers);
    assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(h['List-Unsubscribe'], new RegExp(`^<${APP_URL}/api/unsubscribe\\?u=\\d+&t=[\\w-]+>$`));
  });
});

describe('unsubscribe & preferences', () => {
  async function linkFor(c) {
    const me = (await c('GET', '/api/me')).body.user;
    return `/api/unsubscribe?u=${me.id}&t=${unsubscribeToken('test-secret', me.id)}`;
  }

  test('GET shows confirmation without changing state; POST (form) opts out', async () => {
    const u = await user();
    const link = await linkFor(u);
    const get = await fetch(s.base + link);
    assert.equal(get.status, 200);
    assert.match(get.headers.get('content-type'), /text\/html/);
    const html = await get.text();
    assert.match(html, /<form method="post"/);
    assert.equal((await u('GET', '/api/me')).body.user.emailNotifications, true);

    // RFC 8058 one-click: form-encoded POST without cookies must work (CSRF-exempt).
    const post = await fetch(s.base + link, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    assert.equal(post.status, 200);
    assert.equal((await u('GET', '/api/me')).body.user.emailNotifications, false);
  });

  test('invalid token or user id → 400', async () => {
    const u = await user();
    const me = (await u('GET', '/api/me')).body.user;
    const bad = await fetch(`${s.base}/api/unsubscribe?u=${me.id}&t=nope`);
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get('content-type'), /text\/html/);
    assert.match(await bad.text(), /<html/i);
    assert.equal((await fetch(`${s.base}/api/unsubscribe?u=${me.id + 1}&t=${unsubscribeToken('test-secret', me.id)}`)).status, 400);
    assert.equal((await fetch(`${s.base}/api/unsubscribe?u=abc&t=x`)).status, 400);
    const badPost = await fetch(`${s.base}/api/unsubscribe?u=${me.id}&t=nope`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '',
    });
    assert.equal(badPost.status, 400);
    assert.match(badPost.headers.get('content-type'), /text\/html/);
    assert.equal((await u('GET', '/api/me')).body.user.emailNotifications, true);
  });

  test('PATCH /api/me toggles notifications and validates input', async () => {
    const u = await user();
    assert.equal((await u('PATCH', '/api/me', { emailNotifications: 'no' })).status, 400);
    assert.equal((await u('PATCH', '/api/me', { emailNotifications: false })).body.user.emailNotifications, false);
    const r = await u('PATCH', '/api/me', { emailNotifications: true, name: 'New Name' });
    assert.equal(r.body.user.emailNotifications, true);
    assert.equal(r.body.user.name, 'New Name');
    assert.equal((await client(s.base)('PATCH', '/api/me', { emailNotifications: false })).status, 401);
  });

  test('token helpers', () => {
    const t = unsubscribeToken('k', 5);
    assert.equal(checkUnsubscribeToken('k', 5, t), true);
    assert.equal(checkUnsubscribeToken('k', 6, t), false);
    assert.equal(checkUnsubscribeToken('other', 5, t), false);
    assert.equal(checkUnsubscribeToken('k', 5, undefined), false);
    assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('outbox delivery', () => {
  const freshDb = () => {
    const db = openDb();
    enqueueEmail(db, { to: 'a@x.de', subject: 'S', text: 'T', html: '<p>H</p>', headers: { 'X-A': '1' }, kind: 'test' });
    return db;
  };

  test('memory transport sends and marks sent', async () => {
    const db = freshDb();
    const mailer = createMailer({ transport: 'memory' });
    assert.deepEqual(await processOutbox(db, mailer), { processed: 1, sent: 1 });
    assert.deepEqual(mailer.sent, [{ to: 'a@x.de', subject: 'S', text: 'T', html: '<p>H</p>', headers: { 'X-A': '1' } }]);
    const row = db.prepare('SELECT * FROM email_outbox').get();
    assert.equal(row.status, 'sent');
    assert.equal(row.attempts, 1);
    assert.ok(row.sent_at);
    assert.deepEqual(await processOutbox(db, mailer), { processed: 0, sent: 0 });
  });

  test('transient failures back off exponentially, then fail after 6 attempts', async () => {
    const db = freshDb();
    const mailer = { send: async () => { throw new Error('SMTP down'); } };
    let now = 1_000_000;
    const delays = [];
    for (let i = 1; i <= 6; i++) {
      assert.equal((await processOutbox(db, mailer, { now })).processed, 1);
      const row = db.prepare('SELECT * FROM email_outbox').get();
      assert.equal(row.attempts, i);
      assert.equal(row.last_error, 'SMTP down');
      delays.push(row.next_attempt_at - now);
      if (i < 6) {
        assert.equal(row.status, 'pending');
        // Not due yet just before the backoff expires.
        assert.equal((await processOutbox(db, mailer, { now: row.next_attempt_at - 1 })).processed, 0);
        now = row.next_attempt_at;
      } else {
        assert.equal(row.status, 'failed');
      }
    }
    assert.deepEqual(delays.slice(0, 5), [60_000, 120_000, 240_000, 480_000, 960_000]);
    assert.equal((await processOutbox(db, mailer, { now: Number.MAX_SAFE_INTEGER })).processed, 0);
  });

  test('permanent errors fail immediately; one bad mail does not block others', async () => {
    const db = freshDb();
    enqueueEmail(db, { to: 'b@x.de', subject: 'S2', text: 'T', html: 'H', kind: 'test' });
    const mailer = {
      sent: [],
      send: async (m) => {
        if (m.to === 'a@x.de') throw Object.assign(new Error('invalid address'), { permanent: true });
        mailer.sent.push(m.to);
      },
    };
    assert.deepEqual(await processOutbox(db, mailer), { processed: 2, sent: 1 });
    const rows = db.prepare('SELECT to_email, status, attempts FROM email_outbox ORDER BY id').all();
    assert.deepEqual(rows.map((r) => [r.to_email, r.status, r.attempts]), [['a@x.de', 'failed', 1], ['b@x.de', 'sent', 1]]);
  });

  test('resend transport posts JSON with Bearer auth; 4xx is permanent, 429/5xx transient', async () => {
    const reqs = [];
    let status = 200;
    const fetchImpl = async (url, opts) => {
      reqs.push({ url, opts });
      return new Response(status === 200 ? '{"id":"e1"}' : '{"message":"nope"}', { status });
    };
    const m = createMailer({ transport: 'resend', apiKey: 're_test', from: 'PB <hi@pb.example>', fetchImpl });
    await m.send({ to: 'a@x.de', subject: 'S', text: 'T', html: 'H', headers: { 'List-Unsubscribe': '<u>' } });
    assert.equal(reqs[0].url, 'https://api.resend.com/emails');
    assert.equal(reqs[0].opts.method, 'POST');
    assert.equal(reqs[0].opts.headers.Authorization, 'Bearer re_test');
    assert.equal(reqs[0].opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(reqs[0].opts.body), {
      from: 'PB <hi@pb.example>', to: ['a@x.de'], subject: 'S', text: 'T', html: 'H', headers: { 'List-Unsubscribe': '<u>' },
    });
    for (const [code, permanent] of [[422, true], [403, true], [429, false], [500, false]]) {
      status = code;
      await assert.rejects(m.send({ to: 'a@x.de', subject: 'S', text: 'T', html: 'H', headers: {} }),
        (e) => e.permanent === permanent && e.message.includes(String(code)));
    }
  });

  test('log transport prints a summary; unknown transport throws', async () => {
    const lines = [];
    const m = createMailer({ transport: 'log', logger: { log: (l) => lines.push(l) } });
    await m.send({ to: 'a@x.de', subject: 'Hello' });
    assert.deepEqual(lines, ['[mail] → a@x.de | Hello']);
    await assert.rejects(createMailer({ transport: 'carrier-pigeon' }).send({ to: 'x' }), /Unknown mail transport/);
  });
});

describe('app secret & migrations', () => {
  test('getAppSecret persists per database; env override wins', () => {
    const db = openDb();
    const a = getAppSecret(db);
    assert.ok(a.length >= 32);
    assert.equal(getAppSecret(db), a);
    assert.equal(getAppSecret(db, 'from-env'), 'from-env');
    assert.equal(getAppSecret(db), a);
    assert.notEqual(getAppSecret(openDb()), a);
  });

  test('openDb migrates a pre-billing database and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-mig-'));
    const file = join(dir, 'old.db');
    try {
      // A database as created by the first release: no plan / notification columns.
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
          password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT 'x');
        CREATE TABLE workspaces (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          accent TEXT NOT NULL DEFAULT '#5b5bd6', created_at TEXT NOT NULL DEFAULT 'x');
        INSERT INTO users (email, name, password_hash) VALUES ('old@x.de', 'Old', 'h');
        INSERT INTO workspaces (slug, name) VALUES ('legacy', 'Legacy');
      `);
      assert.equal(old.prepare('PRAGMA user_version').get().user_version, 0);
      old.close();

      const db = openDb(file);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
      const ws = db.prepare("SELECT * FROM workspaces WHERE slug = 'legacy'").get();
      assert.equal(ws.plan, 'free');
      assert.equal(ws.plan_status, 'active');
      assert.equal(ws.stripe_customer_id, null);
      assert.equal(ws.cancel_at_period_end, 0);
      assert.equal(db.prepare("SELECT email_notifications FROM users WHERE email = 'old@x.de'").get().email_notifications, 1);
      for (const t of ['app_meta', 'stripe_events', 'email_outbox']) {
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
      }
      db.close();

      const again = openDb(file); // must not re-run ALTER TABLE
      assert.equal(again.prepare('PRAGMA user_version').get().user_version, 1);
      assert.equal(again.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n, 1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
