import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

function startServer(opts = {}) {
  const srv = createServer(createApp({ db: openDb(), authRateLimit: 1000, ...opts }));
  return new Promise((r) => srv.listen(0, () => r({ srv, base: `http://localhost:${srv.address().port}` })));
}

function client(base) {
  let jar = '';
  const c = async (method, path, body, { contentType = 'application/json', raw = false } = {}) => {
    const headers = { cookie: jar };
    if (body !== undefined) headers['content-type'] = contentType;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) jar = sc.split(';')[0];
    const text = await res.text();
    let json = null;
    if (!raw) try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  c.clearCookies = () => { jar = ''; };
  c.getCookie = () => jar;
  c.setCookie = (v) => { jar = v; };
  return c;
}

let srv, base;
before(async () => ({ srv, base } = await startServer()));
after(() => srv.close());

let n = 0;
async function newUser(name = 'User') {
  const c = client(base);
  const email = `u${++n}@example.com`;
  const r = await c('POST', '/api/auth/signup', { email, name, password: 'password123' });
  assert.equal(r.status, 201);
  c.email = email;
  return c;
}

async function newWorkspace(c, name) {
  const slug = `ws-${++n}-${name.toLowerCase().replace(/[^a-z]/g, '')}`.slice(0, 40);
  const r = await c('POST', '/api/workspaces', { name, slug });
  assert.equal(r.status, 201);
  const w = await c('GET', `/api/w/${slug}`);
  return { slug, boards: w.body.boards };
}

async function newPost(c, ws, title, body = '') {
  const r = await c('POST', `/api/w/${ws.slug}/posts`, { boardId: ws.boards[0].id, title, body });
  assert.equal(r.status, 201, r.text);
  return r.body.post;
}

describe('auth', () => {
  test('signup validation', async () => {
    const c = client(base);
    assert.equal((await c('POST', '/api/auth/signup', { email: 'nope', name: 'X', password: 'password123' })).status, 400);
    assert.equal((await c('POST', '/api/auth/signup', { email: 'x@y.de', name: 'X', password: 'short' })).status, 400);
    assert.equal((await c('POST', '/api/auth/signup', { email: 'x@y.de', password: 'password123' })).status, 400);
    assert.equal((await c('POST', '/api/auth/signup', { email: 'dup@y.de', name: 'X', password: 'password123' })).status, 201);
    const dup = await c('POST', '/api/auth/signup', { email: 'DUP@y.de', name: 'X', password: 'password123' });
    assert.equal(dup.status, 409);
  });

  test('session cookie is HttpOnly + SameSite=Lax', async () => {
    const c = client(base);
    const r = await c('POST', '/api/auth/signup', { email: 'cookie@y.de', name: 'C', password: 'password123' });
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Lax/);
  });

  test('login wrong password → 401, correct → 200', async () => {
    const u = await newUser();
    const c = client(base);
    assert.equal((await c('POST', '/api/auth/login', { email: u.email, password: 'wrongpass1' })).status, 401);
    assert.equal((await c('POST', '/api/auth/login', { email: 'unknown@x.de', password: 'wrongpass1' })).status, 401);
    const ok = await c('POST', '/api/auth/login', { email: u.email.toUpperCase(), password: 'password123' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.email, u.email);
  });

  test('/api/me anonymous and logged in', async () => {
    const anon = await client(base)('GET', '/api/me');
    assert.deepEqual(anon.body, { user: null, workspaces: [] });
    const u = await newUser('Me');
    const ws = await newWorkspace(u, 'Mine');
    const me = await u('GET', '/api/me');
    assert.equal(me.body.user.name, 'Me');
    assert.deepEqual(me.body.workspaces, [{ slug: ws.slug, name: 'Mine', role: 'owner' }]);
  });

  test('logout invalidates the session server-side', async () => {
    const u = await newUser();
    const token = u.getCookie();
    assert.equal((await u('POST', '/api/auth/logout', {})).status, 200);
    const replay = client(base);
    replay.setCookie(token);
    assert.equal((await replay('GET', '/api/me')).body.user, null);
  });

  test('non-JSON content-type → 415', async () => {
    const c = client(base);
    const r = await c('POST', '/api/auth/login', 'email=a&password=b', { contentType: 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 415);
  });

  test('invalid JSON → 400, array body → 400', async () => {
    const c = client(base);
    assert.equal((await c('POST', '/api/auth/login', '{nope')).status, 400);
    assert.equal((await c('POST', '/api/auth/login', '[]')).status, 400);
  });
});

describe('workspaces', () => {
  test('requires login', async () => {
    assert.equal((await client(base)('POST', '/api/workspaces', { name: 'X' })).status, 401);
  });

  test('slug rules, reserved slugs, duplicates', async () => {
    const u = await newUser();
    assert.equal((await u('POST', '/api/workspaces', { name: 'X', slug: 'Bad Slug!' })).status, 400);
    assert.equal((await u('POST', '/api/workspaces', { name: 'X', slug: 'ab' })).status, 400);
    assert.equal((await u('POST', '/api/workspaces', { name: 'X', slug: '-abc' })).status, 400);
    assert.equal((await u('POST', '/api/workspaces', { name: 'Admin', slug: 'admin' })).status, 400);
    const r = await u('POST', '/api/workspaces', { name: 'Über Café GmbH' });
    assert.equal(r.status, 201);
    assert.equal(r.body.workspace.slug, 'uber-cafe-gmbh');
    assert.equal((await u('POST', '/api/workspaces', { name: 'Über Café GmbH' })).status, 409);
  });

  test('new workspace has default boards and owner role', async () => {
    const u = await newUser();
    const ws = await newWorkspace(u, 'Boards');
    assert.deepEqual(ws.boards.map((b) => b.name), ['Feature Requests', 'Bugs']);
    assert.equal((await u('GET', `/api/w/${ws.slug}`)).body.role, 'owner');
    assert.equal((await client(base)('GET', `/api/w/${ws.slug}`)).body.role, null);
    assert.equal((await client(base)('GET', '/api/w/does-not-exist')).status, 404);
  });

  test('admin settings: accent validation, board creation, non-admin forbidden', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Settings');
    assert.equal((await owner('PATCH', `/api/w/${ws.slug}`, { accent: 'red' })).status, 400);
    assert.equal((await owner('PATCH', `/api/w/${ws.slug}`, { accent: '#112233' })).body.workspace.accent, '#112233');
    assert.equal((await owner('POST', `/api/w/${ws.slug}/boards`, { name: 'Ideas' })).status, 201);
    assert.equal((await owner('POST', `/api/w/${ws.slug}/boards`, { name: 'Ideas' })).status, 409);
    const other = await newUser();
    assert.equal((await other('PATCH', `/api/w/${ws.slug}`, { name: 'Hijack' })).status, 403);
    assert.equal((await other('POST', `/api/w/${ws.slug}/boards`, { name: 'X' })).status, 403);
    assert.equal((await client(base)('GET', `/api/w/${ws.slug}/stats`)).status, 401);
  });

  test('only the owner can add admins', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Team');
    const admin = await newUser();
    const stranger = await newUser();
    assert.equal((await owner('POST', `/api/w/${ws.slug}/members`, { email: 'nobody@x.de' })).status, 404);
    const add = await owner('POST', `/api/w/${ws.slug}/members`, { email: admin.email });
    assert.equal(add.status, 201);
    assert.equal(add.body.member.role, 'admin');
    // admin cannot add further admins
    assert.equal((await admin('POST', `/api/w/${ws.slug}/members`, { email: stranger.email })).status, 403);
    assert.equal((await stranger('POST', `/api/w/${ws.slug}/members`, { email: stranger.email })).status, 403);
    // re-adding the owner keeps owner role
    const again = await owner('POST', `/api/w/${ws.slug}/members`, { email: owner.email });
    assert.equal(again.body.member.role, 'owner');
    const members = await admin('GET', `/api/w/${ws.slug}/members`);
    assert.equal(members.body.members.length, 2);
  });
});

describe('posts & votes', () => {
  test('posting requires login', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Login');
    const r = await client(base)('POST', `/api/w/${ws.slug}/posts`, { boardId: ws.boards[0].id, title: 'Hello' });
    assert.equal(r.status, 401);
  });

  test('validation: title length, unknown board', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Valid');
    assert.equal((await owner('POST', `/api/w/${ws.slug}/posts`, { boardId: ws.boards[0].id, title: 'ab' })).status, 400);
    assert.equal((await owner('POST', `/api/w/${ws.slug}/posts`, { boardId: 99999, title: 'Valid title' })).status, 400);
    assert.equal((await owner('POST', `/api/w/${ws.slug}/posts`, { boardId: 'x', title: 'Valid title' })).status, 400);
  });

  test('author auto-votes; vote toggles', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Votes');
    const p = await newPost(owner, ws, 'Auto vote');
    assert.equal(p.votes, 1);
    assert.equal(p.hasVoted, true);
    assert.equal(p.isMine, true);
    const v = await newUser();
    let r = await v('POST', `/api/w/${ws.slug}/posts/${p.id}/vote`);
    assert.deepEqual(r.body, { voted: true, votes: 2 });
    r = await v('POST', `/api/w/${ws.slug}/posts/${p.id}/vote`);
    assert.deepEqual(r.body, { voted: false, votes: 1 });
    assert.equal((await client(base)('POST', `/api/w/${ws.slug}/posts/${p.id}/vote`)).status, 401);
  });

  test('sorting top and new', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Sort');
    const a = await newPost(owner, ws, 'First post');
    const b = await newPost(owner, ws, 'Second post');
    const c = await newPost(owner, ws, 'Third post');
    for (let i = 0; i < 2; i++) {
      const v = await newUser();
      await v('POST', `/api/w/${ws.slug}/posts/${a.id}/vote`);
    }
    const top = await owner('GET', `/api/w/${ws.slug}/posts?sort=top`);
    assert.equal(top.body.posts[0].id, a.id);
    assert.equal(top.body.total, 3);
    const neu = await owner('GET', `/api/w/${ws.slug}/posts?sort=new`);
    assert.deepEqual(neu.body.posts.map((p) => p.id), [c.id, b.id, a.id]);
    const trending = await owner('GET', `/api/w/${ws.slug}/posts?sort=trending`);
    assert.equal(trending.body.posts[0].id, a.id);
    assert.equal((await owner('GET', `/api/w/${ws.slug}/posts?status=bogus`)).status, 400);
    const lim = await owner('GET', `/api/w/${ws.slug}/posts?limit=1`);
    assert.equal(lim.body.posts.length, 1);
    assert.equal(lim.body.total, 3);
  });

  test('search treats LIKE wildcards literally', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Search');
    await newPost(owner, ws, 'Discount 50% off');
    await newPost(owner, ws, 'snake_case keys');
    await newPost(owner, ws, 'Plain title here');
    const pct = await owner('GET', `/api/w/${ws.slug}/posts?q=${encodeURIComponent('%')}`);
    assert.deepEqual(pct.body.posts.map((p) => p.title), ['Discount 50% off']);
    const us = await owner('GET', `/api/w/${ws.slug}/posts?q=${encodeURIComponent('_')}`);
    assert.deepEqual(us.body.posts.map((p) => p.title), ['snake_case keys']);
    const word = await owner('GET', `/api/w/${ws.slug}/posts?q=plain`);
    assert.equal(word.body.posts.length, 1);
  });

  test('similar endpoint finds duplicates, ignores closed and short queries', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Similar');
    const p = await newPost(owner, ws, 'Dark mode for dashboard');
    const closed = await newPost(owner, ws, 'Dark mode on mobile');
    await owner('PATCH', `/api/w/${ws.slug}/posts/${closed.id}`, { status: 'closed' });
    const r = await client(base)('GET', `/api/w/${ws.slug}/similar?q=${encodeURIComponent('dark dashboard theme')}`);
    assert.equal(r.body.posts[0].id, p.id);
    assert.ok(!r.body.posts.some((x) => x.id === closed.id));
    assert.deepEqual((await owner('GET', `/api/w/${ws.slug}/similar?q=ab`)).body, { posts: [] });
  });

  test('permissions: author edits title, non-admin cannot change status, admin status creates event', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Perms');
    const author = await newUser('Author');
    const p = await newPost(author, ws, 'Original title');
    const edit = await author('PATCH', `/api/w/${ws.slug}/posts/${p.id}`, { title: 'Edited title' });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.post.title, 'Edited title');
    assert.equal((await author('PATCH', `/api/w/${ws.slug}/posts/${p.id}`, { status: 'planned' })).status, 403);
    const stranger = await newUser();
    assert.equal((await stranger('PATCH', `/api/w/${ws.slug}/posts/${p.id}`, { title: 'Hacked title' })).status, 403);
    assert.equal((await stranger('DELETE', `/api/w/${ws.slug}/posts/${p.id}`)).status, 403);

    assert.equal((await owner('PATCH', `/api/w/${ws.slug}/posts/${p.id}`, { status: 'nope' })).status, 400);
    const st = await owner('PATCH', `/api/w/${ws.slug}/posts/${p.id}`, { status: 'planned' });
    assert.equal(st.body.post.status, 'planned');
    const detail = await client(base)('GET', `/api/w/${ws.slug}/posts/${p.id}`);
    assert.equal(detail.body.events.length, 1);
    assert.deepEqual(
      { from: detail.body.events[0].fromStatus, to: detail.body.events[0].toStatus },
      { from: 'open', to: 'planned' },
    );
    // same status again → no new event
    await owner('PATCH', `/api/w/${ws.slug}/posts/${p.id}`, { status: 'planned' });
    assert.equal((await owner('GET', `/api/w/${ws.slug}/posts/${p.id}`)).body.events.length, 1);
    // admin can move board
    const mv = await owner('PATCH', `/api/w/${ws.slug}/posts/${p.id}`, { boardId: ws.boards[1].id });
    assert.equal(mv.body.post.boardId, ws.boards[1].id);
    // author can delete own post
    assert.equal((await author('DELETE', `/api/w/${ws.slug}/posts/${p.id}`)).status, 200);
    assert.equal((await author('GET', `/api/w/${ws.slug}/posts/${p.id}`)).status, 404);
  });

  test('comments: admin flag, login required', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Comments');
    const user = await newUser();
    const p = await newPost(user, ws, 'Commentable');
    assert.equal((await client(base)('POST', `/api/w/${ws.slug}/posts/${p.id}/comments`, { body: 'x' })).status, 401);
    assert.equal((await user('POST', `/api/w/${ws.slug}/posts/${p.id}/comments`, { body: '' })).status, 400);
    const c1 = await user('POST', `/api/w/${ws.slug}/posts/${p.id}/comments`, { body: 'Me too' });
    const c2 = await owner('POST', `/api/w/${ws.slug}/posts/${p.id}/comments`, { body: 'On it' });
    assert.equal(c1.body.comment.isAdmin, false);
    assert.equal(c2.body.comment.isAdmin, true);
    const d = await user('GET', `/api/w/${ws.slug}/posts/${p.id}`);
    assert.deepEqual(d.body.comments.map((c) => c.body), ['Me too', 'On it']);
    assert.equal(d.body.post.comments, 2);
  });

  test('cross-workspace isolation', async () => {
    const a = await newUser();
    const wsA = await newWorkspace(a, 'Alpha');
    const b = await newUser();
    const wsB = await newWorkspace(b, 'Beta');
    const p = await newPost(a, wsA, 'Secret of alpha');
    assert.equal((await b('GET', `/api/w/${wsB.slug}/posts/${p.id}`)).status, 404);
    assert.equal((await b('PATCH', `/api/w/${wsB.slug}/posts/${p.id}`, { status: 'closed' })).status, 404);
    assert.equal((await b('DELETE', `/api/w/${wsB.slug}/posts/${p.id}`)).status, 404);
    assert.equal((await b('POST', `/api/w/${wsB.slug}/posts/${p.id}/vote`)).status, 404);
    // board of A cannot be used in B
    const r = await b('POST', `/api/w/${wsB.slug}/posts`, { boardId: wsA.boards[0].id, title: 'Sneaky post' });
    assert.equal(r.status, 400);
    // admin of B is not admin of A
    assert.equal((await b('PATCH', `/api/w/${wsA.slug}/posts/${p.id}`, { status: 'closed' })).status, 403);
    // changelog in B cannot link A's post
    assert.equal((await b('POST', `/api/w/${wsB.slug}/changelog`, { title: 'x', postIds: [p.id] })).status, 400);
    assert.equal((await b('GET', `/api/w/${wsB.slug}/posts`)).body.total, 0);
  });
});

describe('roadmap, changelog, stats, export', () => {
  test('roadmap groups planned/in_progress/done only', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Roadmap');
    const p1 = await newPost(owner, ws, 'Planned thing');
    const p2 = await newPost(owner, ws, 'In progress thing');
    await newPost(owner, ws, 'Open thing');
    await owner('PATCH', `/api/w/${ws.slug}/posts/${p1.id}`, { status: 'planned' });
    await owner('PATCH', `/api/w/${ws.slug}/posts/${p2.id}`, { status: 'in_progress' });
    const r = await client(base)('GET', `/api/w/${ws.slug}/roadmap`);
    assert.deepEqual(Object.keys(r.body.columns), ['planned', 'in_progress', 'done']);
    assert.deepEqual(r.body.columns.planned.map((p) => p.id), [p1.id]);
    assert.deepEqual(r.body.columns.in_progress.map((p) => p.id), [p2.id]);
    assert.equal(r.body.columns.done.length, 0);
  });

  test('changelog with markDone sets posts to done; markDone:false leaves them', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Changelog');
    const p1 = await newPost(owner, ws, 'Ship me');
    const p2 = await newPost(owner, ws, 'Mention me');
    const nonAdmin = await newUser();
    assert.equal((await nonAdmin('POST', `/api/w/${ws.slug}/changelog`, { title: 'x' })).status, 403);
    const r = await owner('POST', `/api/w/${ws.slug}/changelog`, { title: 'v1.0', body: 'Hi', postIds: [p1.id, p1.id] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.entry.postIds, [p1.id]);
    await owner('POST', `/api/w/${ws.slug}/changelog`, { title: 'v1.1', postIds: [p2.id], markDone: false });
    assert.equal((await owner('GET', `/api/w/${ws.slug}/posts/${p1.id}`)).body.post.status, 'done');
    assert.equal((await owner('GET', `/api/w/${ws.slug}/posts/${p2.id}`)).body.post.status, 'open');
    const d = await owner('GET', `/api/w/${ws.slug}/posts/${p1.id}`);
    assert.equal(d.body.events.at(-1).toStatus, 'done');
    const list = await client(base)('GET', `/api/w/${ws.slug}/changelog`);
    assert.equal(list.body.entries.length, 2);
    assert.deepEqual(list.body.entries.find((e) => e.title === 'v1.0').posts, [{ id: p1.id, title: 'Ship me' }]);
    // unknown post rolls back the whole entry
    assert.equal((await owner('POST', `/api/w/${ws.slug}/changelog`, { title: 'bad', postIds: [999999] })).status, 400);
    assert.equal((await owner('GET', `/api/w/${ws.slug}/changelog`)).body.entries.length, 2);
  });

  test('stats shape', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Stats');
    const p = await newPost(owner, ws, 'Stat post');
    await owner('POST', `/api/w/${ws.slug}/posts/${p.id}/comments`, { body: 'c' });
    const v = await newUser();
    await v('POST', `/api/w/${ws.slug}/posts/${p.id}/vote`);
    assert.equal((await v('GET', `/api/w/${ws.slug}/stats`)).status, 403);
    const s = (await owner('GET', `/api/w/${ws.slug}/stats`)).body;
    assert.deepEqual(s.totals, { posts: 1, votes: 2, comments: 1, voters: 2 });
    assert.equal(s.byStatus.open, 1);
    assert.equal(Object.keys(s.byStatus).length, 6);
    assert.equal(s.activity.days.length, 30);
    assert.equal(s.activity.posts.length, 30);
    assert.equal(s.activity.posts.at(-1), 1);
    assert.equal(s.activity.votes.at(-1), 2);
    assert.equal(s.untriaged[0].id, p.id);
  });

  test('CSV export with formula-injection guard', async () => {
    const owner = await newUser();
    const ws = await newWorkspace(owner, 'Export');
    await newPost(owner, ws, '=HYPERLINK("http://evil")', 'line1\nline2, "quoted"');
    await newPost(owner, ws, 'Normal title');
    assert.equal((await (await newUser())('GET', `/api/w/${ws.slug}/export.csv`)).status, 403);
    const r = await owner('GET', `/api/w/${ws.slug}/export.csv`, undefined, { raw: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), new RegExp(`${ws.slug}-feedback\\.csv`));
    const text = r.text.replace(/^﻿/, '');
    assert.ok(text.startsWith('id,board,title,body,status,votes,comments,author,created_at'));
    assert.ok(text.includes(`"'=HYPERLINK(""http://evil"")"`), text);
    assert.ok(text.includes('"line1\nline2, ""quoted"""'));
    assert.ok(!/,=HYPERLINK/.test(text));
  });
});

describe('misc', () => {
  test('unknown endpoint 404, wrong method 405, health ok, security headers', async () => {
    const c = client(base);
    assert.equal((await c('GET', '/api/nope')).status, 404);
    assert.equal((await c('DELETE', '/api/me')).status, 405);
    const h = await c('GET', '/api/health');
    assert.deepEqual(h.body, { ok: true });
    assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
    assert.match(h.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });
});

describe('rate limiting', () => {
  let s2;
  before(async () => (s2 = await startServer({ authRateLimit: 2 })));
  after(() => s2.srv.close());

  test('auth limiter returns 429 after limit', async () => {
    const c = client(s2.base);
    const body = { email: 'x@y.de', password: 'whatever12' };
    assert.equal((await c('POST', '/api/auth/login', body)).status, 401);
    assert.equal((await c('POST', '/api/auth/login', body)).status, 401);
    assert.equal((await c('POST', '/api/auth/login', body)).status, 429);
  });
});

describe('static files', () => {
  let s3, dir, secretDir;
  before(async () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-static-'));
    dir = join(root, 'public');
    secretDir = root;
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SPA</title>');
    writeFileSync(join(dir, 'widget.js'), 'console.log(1)');
    writeFileSync(join(root, 'secret.txt'), 'TOP SECRET');
    s3 = await startServer({ publicDir: dir });
  });
  after(() => {
    s3.srv.close();
    rmSync(secretDir, { recursive: true, force: true });
  });

  // fetch() normalises "../", so send raw paths via http.request.
  const rawGet = (path) =>
    new Promise((resolve, reject) => {
      const u = new URL(s3.base);
      const req = httpRequest({ host: u.hostname, port: u.port, path, method: 'GET' }, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });

  test('serves files and SPA fallback', async () => {
    const idx = await rawGet('/');
    assert.equal(idx.status, 200);
    assert.match(idx.body, /SPA/);
    const deep = await rawGet('/acme/roadmap');
    assert.equal(deep.status, 200);
    assert.match(deep.body, /SPA/);
    const w = await rawGet('/widget.js');
    assert.equal(w.headers['access-control-allow-origin'], '*');
    assert.equal((await rawGet('/missing.css')).status, 404);
  });

  test('path traversal returns 404', async () => {
    for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/x/../../secret.txt']) {
      const r = await rawGet(p);
      assert.equal(r.status, 404, `${p} → ${r.status}`);
      assert.ok(!r.body.includes('TOP SECRET'), p);
    }
  });

  test('non-GET on static path → 405', async () => {
    const r = await fetch(s3.base + '/index.html', { method: 'POST' });
    assert.equal(r.status, 405);
  });
});
