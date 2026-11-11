import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import {
  Router, HttpError, bad, unauthorized, forbidden, notFound,
  readJson, readRaw, parseCookies, cookie, sendJson, sendHtml, str, int,
} from './http.js';
import {
  SESSION_COOKIE, hashPassword, verifyPassword, createSession,
  destroySession, userFromToken, rateLimiter,
} from './auth.js';
import { findSimilar, trendingScore } from './similar.js';
import { tx } from './db.js';
import { PLANS, PAID_PLANS, effectivePlan, planInfo, withinLimit } from './plans.js';
import { verifyWebhook, StripeError } from './stripe.js';
import { getAppSecret, checkUnsubscribeToken, escapeHtml } from './mail.js';
import { notifyStatusChange, notifyAdminComment, notifyChangelog, notifyPaymentFailed } from './notify.js';

export const STATUSES = ['open', 'under_review', 'planned', 'in_progress', 'done', 'closed'];
const ROADMAP_STATUSES = ['planned', 'in_progress', 'done'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const RESERVED_SLUGS = new Set(['api', 'app', 'admin', 'login', 'signup', 'new', 'static', 'widget']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// Endpoints authenticated by something other than the session cookie
// (Stripe signature / HMAC link token) are exempt from the JSON-CSRF rule.
const CSRF_EXEMPT = new Set(['/api/stripe/webhook', '/api/unsubscribe']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Client IP for rate limiting. With trustProxy = N, the N-th entry from the
 * right of X-Forwarded-For is used (the one appended by our own outermost
 * proxy); left-most entries are client-controlled and never trusted.
 */
export function clientIp(req, trustProxy = 0) {
  const socketIp = req.socket?.remoteAddress ?? 'unknown';
  if (!trustProxy) return socketIp;
  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return chain.length >= trustProxy ? chain[chain.length - trustProxy] : socketIp;
}

const paymentRequired = (feature, message) => new HttpError(402, message, { feature, upgrade: true });

/**
 * stripe:  client from createStripeClient() or null (billing disabled)
 * billing: { webhookSecret, prices: { pro, business } }  (Stripe price ids)
 */
export function createApp({
  db, publicDir, secureCookies = false, authRateLimit = 20,
  appUrl = 'http://localhost:3000', secret, stripe = null, billing = {},
  trustProxy = 0,
} = {}) {
  const router = new Router();
  const mailCfg = { appUrl: appUrl.replace(/\/+$/, ''), secret: getAppSecret(db, secret) };
  const prices = billing.prices ?? {};
  const planByPrice = new Map(Object.entries(prices).filter(([, v]) => v).map(([k, v]) => [v, k]));
  const authLimiter = rateLimiter({ limit: authRateLimit, windowMs: 15 * 60 * 1000 });
  const writeLimiter = rateLimiter({ limit: 60, windowMs: 60 * 1000 });

  // ---- shared lookups -----------------------------------------------------

  const q = {
    wsBySlug: db.prepare('SELECT * FROM workspaces WHERE slug = ?'),
    wsById: db.prepare('SELECT * FROM workspaces WHERE id = ?'),
    role: db.prepare('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?'),
    post: db.prepare(
      `SELECT p.*, u.name AS author_name,
              (SELECT COUNT(*) FROM votes v WHERE v.post_id = p.id) AS votes,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
         FROM posts p JOIN users u ON u.id = p.author_id
        WHERE p.id = ? AND p.workspace_id = ?`,
    ),
    hasVoted: db.prepare('SELECT 1 FROM votes WHERE post_id = ? AND user_id = ?'),
  };

  function workspace(ctx) {
    const ws = q.wsBySlug.get(ctx.params.slug);
    if (!ws) throw notFound('Workspace not found');
    ctx.ws = ws;
    ctx.role = ctx.user ? q.role.get(ws.id, ctx.user.id)?.role ?? null : null;
    return ws;
  }

  function requireUser(ctx) {
    if (!ctx.user) throw unauthorized();
    return ctx.user;
  }

  function requireAdmin(ctx) {
    workspace(ctx);
    requireUser(ctx);
    if (!ctx.role) throw forbidden('Admin access required');
  }

  function requireOwner(ctx) {
    requireAdmin(ctx);
    if (ctx.role !== 'owner') throw forbidden('Only the workspace owner can do this');
  }

  function usage(wsId) {
    return {
      boards: db.prepare('SELECT COUNT(*) AS n FROM boards WHERE workspace_id = ?').get(wsId).n,
      admins: db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ?').get(wsId).n,
    };
  }

  function rateLimit(ctx, limiter, scope) {
    const key = `${scope}:${ctx.user?.id ?? ctx.ip}`;
    if (!limiter(key)) throw new HttpError(429, 'Too many requests, slow down');
  }

  function postDto(row, ctx) {
    return {
      id: row.id,
      boardId: row.board_id,
      title: row.title,
      body: row.body,
      status: row.status,
      votes: row.votes,
      comments: row.comment_count,
      hasVoted: ctx.user ? Boolean(q.hasVoted.get(row.id, ctx.user.id)) : false,
      author: { name: row.author_name },
      isMine: ctx.user ? row.author_id === ctx.user.id : false,
      createdAt: row.created_at,
    };
  }

  function loadPost(ctx) {
    const row = q.post.get(int(ctx.params.id, 'id'), ctx.ws.id);
    if (!row) throw notFound('Post not found');
    return row;
  }

  function listPosts(ctx, { boardId, status, statuses, search } = {}) {
    const where = ['p.workspace_id = ?'];
    const args = [ctx.ws.id];
    if (boardId) { where.push('p.board_id = ?'); args.push(boardId); }
    if (status) { where.push('p.status = ?'); args.push(status); }
    if (statuses) {
      where.push(`p.status IN (${statuses.map(() => '?').join(',')})`);
      args.push(...statuses);
    }
    if (search) {
      where.push("(p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\')");
      const like = `%${search.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      args.push(like, like);
    }
    return db.prepare(
      `SELECT p.*, u.name AS author_name,
              (SELECT COUNT(*) FROM votes v WHERE v.post_id = p.id) AS votes,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
         FROM posts p JOIN users u ON u.id = p.author_id
        WHERE ${where.join(' AND ')}`,
    ).all(...args);
  }

  function sortPosts(rows, sort) {
    const now = Date.now();
    const byNew = (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id;
    if (sort === 'new') return rows.sort(byNew);
    if (sort === 'trending') {
      return rows
        .map((r) => ({ r, s: trendingScore(r.votes, r.created_at, now) }))
        .sort((a, b) => b.s - a.s || byNew(a.r, b.r))
        .map((x) => x.r);
    }
    return rows.sort((a, b) => b.votes - a.votes || byNew(a, b));
  }

  function startSession(res, userId) {
    const { token, maxAge } = createSession(db, userId);
    res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, token, { maxAge, secure: secureCookies }));
  }

  // ---- auth ---------------------------------------------------------------

  router.post('/api/auth/signup', async (ctx) => {
    rateLimit(ctx, authLimiter, 'auth');
    const b = await readJson(ctx.req);
    const email = str(b.email, 'email', { max: 254 }).toLowerCase();
    if (!EMAIL_RE.test(email)) throw bad('email is invalid');
    const name = str(b.name, 'name', { max: 80 });
    const password = typeof b.password === 'string' ? b.password : '';
    if (password.length < 8 || password.length > 200) {
      throw bad('password must be 8–200 characters');
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'An account with this email already exists');
    }
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
      .run(email, name, hashPassword(password));
    const id = Number(lastInsertRowid);
    startSession(ctx.res, id);
    return [201, { user: { id, email, name } }];
  });

  router.post('/api/auth/login', async (ctx) => {
    rateLimit(ctx, authLimiter, 'auth');
    const b = await readJson(ctx.req);
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    const row = db.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?').get(email);
    if (!row || !verifyPassword(password, row.password_hash)) {
      throw unauthorized('Invalid email or password');
    }
    startSession(ctx.res, row.id);
    return { user: { id: row.id, email: row.email, name: row.name } };
  });

  router.post('/api/auth/logout', async (ctx) => {
    destroySession(db, ctx.cookies[SESSION_COOKIE]);
    ctx.res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, '', { maxAge: 0, secure: secureCookies }));
    return { ok: true };
  });

  router.get('/api/me', (ctx) => {
    if (!ctx.user) return { user: null, workspaces: [] };
    const workspaces = db.prepare(
      `SELECT w.slug, w.name, m.role FROM memberships m
         JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = ? ORDER BY w.name`,
    ).all(ctx.user.id);
    const { email_notifications: n } = db.prepare('SELECT email_notifications FROM users WHERE id = ?').get(ctx.user.id);
    return { user: { ...ctx.user, emailNotifications: Boolean(n) }, workspaces };
  });

  router.patch('/api/me', async (ctx) => {
    const user = requireUser(ctx);
    const b = await readJson(ctx.req);
    if (b.emailNotifications !== undefined) {
      if (typeof b.emailNotifications !== 'boolean') throw bad('emailNotifications must be a boolean');
      db.prepare('UPDATE users SET email_notifications = ? WHERE id = ?').run(b.emailNotifications ? 1 : 0, user.id);
    }
    if (b.name !== undefined) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(str(b.name, 'name', { max: 80 }), user.id);
    }
    const row = db.prepare('SELECT id, email, name, email_notifications FROM users WHERE id = ?').get(user.id);
    return { user: { id: row.id, email: row.email, name: row.name, emailNotifications: Boolean(row.email_notifications) } };
  });

  // One-click unsubscribe from email links. GET shows a confirmation page
  // (mail scanners prefetch links), POST performs it (RFC 8058 one-click).
  function unsubscribeUser(ctx) {
    const userId = Number(ctx.url.searchParams.get('u'));
    const token = ctx.url.searchParams.get('t');
    if (!Number.isInteger(userId) || !checkUnsubscribeToken(mailCfg.secret, userId, token)) {
      sendHtml(ctx.res, 400, page('Link ungültig',
        '<p>Dieser Abmelde-Link ist ungültig oder unvollständig. Du kannst Benachrichtigungen jederzeit in deinem <a href="/account">Konto</a> abschalten.</p>'));
      return null;
    }
    return userId;
  }
  const page = (title, body) => `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/app.css"></head><body><main class="container narrow" style="padding:48px 16px">
<div class="card"><h1>${escapeHtml(title)}</h1>${body}</div></main></body></html>`;

  router.get('/api/unsubscribe', (ctx) => {
    if (unsubscribeUser(ctx) === null) return;
    const action = `/api/unsubscribe?${new URLSearchParams({ u: ctx.url.searchParams.get('u'), t: ctx.url.searchParams.get('t') })}`;
    sendHtml(ctx.res, 200, page('E-Mails abbestellen',
      `<p>Möchtest du keine Benachrichtigungen mehr zu Ideen erhalten?</p>
<form method="post" action="${escapeHtml(action)}"><button class="btn-primary" type="submit">Abbestellen</button></form>`));
  });

  router.post('/api/unsubscribe', (ctx) => {
    const userId = unsubscribeUser(ctx);
    if (userId === null) return;
    db.prepare('UPDATE users SET email_notifications = 0 WHERE id = ?').run(userId);
    sendHtml(ctx.res, 200, page('Abbestellt',
      '<p>Du erhältst keine Benachrichtigungen mehr. Du kannst sie jederzeit in deinem Konto wieder aktivieren.</p><p><a href="/account">Zum Konto</a></p>'));
  });

  // ---- workspaces ---------------------------------------------------------

  router.post('/api/workspaces', async (ctx) => {
    const user = requireUser(ctx);
    rateLimit(ctx, writeLimiter, 'write');
    const b = await readJson(ctx.req);
    const name = str(b.name, 'name', { max: 60 });
    const slug = b.slug ? str(b.slug, 'slug', { max: 40 }).toLowerCase() : slugify(name);
    if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) {
      throw bad('slug must be 3–40 chars: lowercase letters, digits and dashes');
    }
    if (q.wsBySlug.get(slug)) throw new HttpError(409, 'This URL is already taken');
    const freeOwned = db.prepare(
      `SELECT w.* FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = ? AND m.role = 'owner'`,
    ).all(user.id).filter((w) => effectivePlan(w) === 'free').length;
    if (!withinLimit(PLANS.free.limits.ownedWorkspaces, freeOwned)) {
      throw paymentRequired('workspaces', 'The Free plan includes one workspace. Upgrade an existing workspace to create more.');
    }
    tx(db, () => {
      const wsId = Number(
        db.prepare('INSERT INTO workspaces (slug, name) VALUES (?, ?)').run(slug, name).lastInsertRowid,
      );
      db.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')")
        .run(wsId, user.id);
      db.prepare('INSERT INTO boards (workspace_id, name) VALUES (?, ?)').run(wsId, 'Feature Requests');
      db.prepare('INSERT INTO boards (workspace_id, name) VALUES (?, ?)').run(wsId, 'Bugs');
    });
    return [201, { workspace: { slug, name } }];
  });

  router.get('/api/w/:slug', (ctx) => {
    const ws = workspace(ctx);
    const boards = db.prepare(
      `SELECT b.id, b.name, (SELECT COUNT(*) FROM posts p WHERE p.board_id = b.id) AS postCount
         FROM boards b WHERE b.workspace_id = ? ORDER BY b.id`,
    ).all(ws.id);
    return {
      workspace: { slug: ws.slug, name: ws.name, accent: ws.accent },
      boards,
      role: ctx.role,
      statuses: STATUSES,
      ...(ctx.role ? { plan: planInfo(ws) } : {}),
    };
  });

  router.patch('/api/w/:slug', async (ctx) => {
    requireAdmin(ctx);
    const b = await readJson(ctx.req);
    const name = b.name !== undefined ? str(b.name, 'name', { max: 60 }) : ctx.ws.name;
    const accent = b.accent !== undefined ? String(b.accent) : ctx.ws.accent;
    if (!COLOR_RE.test(accent)) throw bad('accent must be a hex color like #5b5bd6');
    if (accent.toLowerCase() !== ctx.ws.accent.toLowerCase() && !planInfo(ctx.ws).features.branding) {
      throw paymentRequired('branding', 'Custom colors are available on Pro and Business.');
    }
    db.prepare('UPDATE workspaces SET name = ?, accent = ? WHERE id = ?').run(name, accent, ctx.ws.id);
    return { workspace: { slug: ctx.ws.slug, name, accent } };
  });

  router.get('/api/w/:slug/members', (ctx) => {
    requireAdmin(ctx);
    const members = db.prepare(
      `SELECT u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? ORDER BY m.role DESC, u.name`,
    ).all(ctx.ws.id);
    return { members };
  });

  router.post('/api/w/:slug/members', async (ctx) => {
    requireAdmin(ctx);
    if (ctx.role !== 'owner') throw forbidden('Only the owner can add admins');
    const b = await readJson(ctx.req);
    const email = str(b.email, 'email', { max: 254 }).toLowerCase();
    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
    if (!user) throw notFound('No user with this email — they need to sign up first');
    const plan = planInfo(ctx.ws);
    if (!q.role.get(ctx.ws.id, user.id) && !withinLimit(plan.limits.admins, usage(ctx.ws.id).admins)) {
      throw paymentRequired('admins', `The ${plan.name} plan allows ${plan.limits.admins} admin(s). Upgrade to add more.`);
    }
    db.prepare(
      "INSERT OR IGNORE INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'admin')",
    ).run(ctx.ws.id, user.id);
    return [201, { member: { name: user.name, email: user.email, role: q.role.get(ctx.ws.id, user.id).role } }];
  });

  router.post('/api/w/:slug/boards', async (ctx) => {
    requireAdmin(ctx);
    const b = await readJson(ctx.req);
    const name = str(b.name, 'name', { max: 40 });
    const plan = planInfo(ctx.ws);
    if (!withinLimit(plan.limits.boards, usage(ctx.ws.id).boards)) {
      throw paymentRequired('boards', `The ${plan.name} plan allows ${plan.limits.boards} boards. Upgrade to add more.`);
    }
    try {
      const id = Number(
        db.prepare('INSERT INTO boards (workspace_id, name) VALUES (?, ?)').run(ctx.ws.id, name).lastInsertRowid,
      );
      return [201, { board: { id, name, postCount: 0 } }];
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Board already exists');
      throw e;
    }
  });

  // ---- posts --------------------------------------------------------------

  router.get('/api/w/:slug/posts', (ctx) => {
    workspace(ctx);
    const sp = ctx.url.searchParams;
    const status = sp.get('status') || undefined;
    if (status && !STATUSES.includes(status)) throw bad('Unknown status');
    const boardId = sp.get('board') ? int(sp.get('board'), 'board') : undefined;
    const search = sp.get('q')?.trim().slice(0, 100) || undefined;
    const limit = Math.min(Number(sp.get('limit')) || 100, 200);
    const rows = sortPosts(listPosts(ctx, { boardId, status, search }), sp.get('sort') || 'top');
    return { posts: rows.slice(0, limit).map((r) => postDto(r, ctx)), total: rows.length };
  });

  router.get('/api/w/:slug/similar', (ctx) => {
    workspace(ctx);
    const text = ctx.url.searchParams.get('q')?.slice(0, 200) ?? '';
    if (text.trim().length < 3) return { posts: [] };
    const rows = listPosts(ctx).filter((r) => r.status !== 'closed');
    const hits = findSimilar(text, rows);
    return {
      posts: hits.map((h) => ({
        id: h.id, title: h.title, status: h.status, votes: h.votes,
        hasVoted: ctx.user ? Boolean(q.hasVoted.get(h.id, ctx.user.id)) : false,
        score: +h.score.toFixed(2),
      })),
    };
  });

  router.post('/api/w/:slug/posts', async (ctx) => {
    workspace(ctx);
    const user = requireUser(ctx);
    rateLimit(ctx, writeLimiter, 'write');
    const b = await readJson(ctx.req);
    const boardId = int(b.boardId, 'boardId');
    const board = db.prepare('SELECT id FROM boards WHERE id = ? AND workspace_id = ?').get(boardId, ctx.ws.id);
    if (!board) throw bad('Unknown board');
    const title = str(b.title, 'title', { min: 3, max: 140 });
    const body = str(b.body, 'body', { max: 5000, optional: true });
    const id = tx(db, () => {
      const pid = Number(
        db.prepare('INSERT INTO posts (workspace_id, board_id, author_id, title, body) VALUES (?, ?, ?, ?, ?)')
          .run(ctx.ws.id, boardId, user.id, title, body).lastInsertRowid,
      );
      // Authors implicitly want their own idea.
      db.prepare('INSERT INTO votes (post_id, user_id) VALUES (?, ?)').run(pid, user.id);
      return pid;
    });
    return [201, { post: postDto(q.post.get(id, ctx.ws.id), ctx) }];
  });

  router.get('/api/w/:slug/posts/:id', (ctx) => {
    workspace(ctx);
    const row = loadPost(ctx);
    const comments = db.prepare(
      `SELECT c.id, c.body, c.is_admin AS isAdmin, c.created_at AS createdAt, u.name AS authorName
         FROM comments c JOIN users u ON u.id = c.author_id
        WHERE c.post_id = ? ORDER BY c.created_at, c.id`,
    ).all(row.id).map((c) => ({ ...c, isAdmin: Boolean(c.isAdmin) }));
    const events = db.prepare(
      `SELECT e.from_status AS fromStatus, e.to_status AS toStatus, e.created_at AS createdAt,
              u.name AS actorName
         FROM post_events e JOIN users u ON u.id = e.actor_id
        WHERE e.post_id = ? ORDER BY e.created_at, e.id`,
    ).all(row.id);
    return { post: postDto(row, ctx), comments, events };
  });

  router.patch('/api/w/:slug/posts/:id', async (ctx) => {
    workspace(ctx);
    const user = requireUser(ctx);
    const row = loadPost(ctx);
    const isAdmin = Boolean(ctx.role);
    if (!isAdmin && row.author_id !== user.id) throw forbidden();
    const b = await readJson(ctx.req);
    const next = { title: row.title, body: row.body, status: row.status, board_id: row.board_id };
    if (b.title !== undefined) next.title = str(b.title, 'title', { min: 3, max: 140 });
    if (b.body !== undefined) next.body = str(b.body, 'body', { max: 5000, optional: true });
    if (b.status !== undefined || b.boardId !== undefined) {
      if (!isAdmin) throw forbidden('Only admins can change status or board');
      if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) throw bad('Unknown status');
        next.status = b.status;
      }
      if (b.boardId !== undefined) {
        const bid = int(b.boardId, 'boardId');
        if (!db.prepare('SELECT 1 FROM boards WHERE id = ? AND workspace_id = ?').get(bid, ctx.ws.id)) {
          throw bad('Unknown board');
        }
        next.board_id = bid;
      }
    }
    tx(db, () => {
      db.prepare('UPDATE posts SET title = ?, body = ?, status = ?, board_id = ? WHERE id = ?')
        .run(next.title, next.body, next.status, next.board_id, row.id);
      if (next.status !== row.status) {
        db.prepare('INSERT INTO post_events (post_id, actor_id, from_status, to_status) VALUES (?, ?, ?, ?)')
          .run(row.id, user.id, row.status, next.status);
        notifyStatusChange(db, mailCfg, {
          ws: ctx.ws, post: { id: row.id, title: next.title }, from: row.status, to: next.status, actorId: user.id,
        });
      }
    });
    return { post: postDto(q.post.get(row.id, ctx.ws.id), ctx) };
  });

  router.delete('/api/w/:slug/posts/:id', (ctx) => {
    workspace(ctx);
    const user = requireUser(ctx);
    const row = loadPost(ctx);
    if (!ctx.role && row.author_id !== user.id) throw forbidden();
    db.prepare('DELETE FROM posts WHERE id = ?').run(row.id);
    return { ok: true };
  });

  router.post('/api/w/:slug/posts/:id/vote', (ctx) => {
    workspace(ctx);
    const user = requireUser(ctx);
    rateLimit(ctx, writeLimiter, 'write');
    const row = loadPost(ctx);
    const existing = q.hasVoted.get(row.id, user.id);
    if (existing) db.prepare('DELETE FROM votes WHERE post_id = ? AND user_id = ?').run(row.id, user.id);
    else db.prepare('INSERT INTO votes (post_id, user_id) VALUES (?, ?)').run(row.id, user.id);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE post_id = ?').get(row.id);
    return { voted: !existing, votes: n };
  });

  router.post('/api/w/:slug/posts/:id/comments', async (ctx) => {
    workspace(ctx);
    const user = requireUser(ctx);
    rateLimit(ctx, writeLimiter, 'write');
    const row = loadPost(ctx);
    const b = await readJson(ctx.req);
    const body = str(b.body, 'body', { max: 3000 });
    const isAdmin = ctx.role ? 1 : 0;
    const id = tx(db, () => {
      const cid = Number(
        db.prepare('INSERT INTO comments (post_id, author_id, body, is_admin) VALUES (?, ?, ?, ?)')
          .run(row.id, user.id, body, isAdmin).lastInsertRowid,
      );
      if (isAdmin) notifyAdminComment(db, mailCfg, { ws: ctx.ws, post: row, comment: body, actor: user });
      return cid;
    });
    const c = db.prepare('SELECT created_at FROM comments WHERE id = ?').get(id);
    return [201, { comment: { id, body, isAdmin: Boolean(isAdmin), authorName: user.name, createdAt: c.created_at } }];
  });

  // ---- roadmap & changelog -----------------------------------------------

  router.get('/api/w/:slug/roadmap', (ctx) => {
    workspace(ctx);
    const rows = sortPosts(listPosts(ctx, { statuses: ROADMAP_STATUSES }), 'top');
    const columns = Object.fromEntries(ROADMAP_STATUSES.map((s) => [s, []]));
    for (const r of rows) columns[r.status].push(postDto(r, ctx));
    return { columns };
  });

  router.get('/api/w/:slug/changelog', (ctx) => {
    const ws = workspace(ctx);
    const entries = db.prepare(
      'SELECT id, title, body, created_at AS createdAt FROM changelog WHERE workspace_id = ? ORDER BY created_at DESC, id DESC',
    ).all(ws.id);
    const linked = db.prepare(
      `SELECT p.id, p.title FROM changelog_posts cp JOIN posts p ON p.id = cp.post_id
        WHERE cp.changelog_id = ? ORDER BY p.id`,
    );
    return { entries: entries.map((e) => ({ ...e, posts: linked.all(e.id) })) };
  });

  router.post('/api/w/:slug/changelog', async (ctx) => {
    requireAdmin(ctx);
    const b = await readJson(ctx.req);
    const title = str(b.title, 'title', { max: 140 });
    const body = str(b.body, 'body', { max: 10000, optional: true });
    const postIds = Array.isArray(b.postIds) ? [...new Set(b.postIds.map((x) => int(x, 'postIds[]')))] : [];
    const markDone = b.markDone !== false;
    const id = tx(db, () => {
      const cid = Number(
        db.prepare('INSERT INTO changelog (workspace_id, title, body) VALUES (?, ?, ?)')
          .run(ctx.ws.id, title, body).lastInsertRowid,
      );
      const shipped = [];
      for (const pid of postIds) {
        const p = db.prepare('SELECT id, title, status FROM posts WHERE id = ? AND workspace_id = ?').get(pid, ctx.ws.id);
        if (!p) throw bad(`Unknown post ${pid}`);
        db.prepare('INSERT INTO changelog_posts (changelog_id, post_id) VALUES (?, ?)').run(cid, pid);
        // Shipping an idea closes the loop: linked posts become "done".
        if (markDone && p.status !== 'done') {
          db.prepare("UPDATE posts SET status = 'done' WHERE id = ?").run(pid);
          db.prepare("INSERT INTO post_events (post_id, actor_id, from_status, to_status) VALUES (?, ?, ?, 'done')")
            .run(pid, ctx.user.id, p.status);
        }
        shipped.push(p);
      }
      // One digest email per subscriber instead of one per status change.
      notifyChangelog(db, mailCfg, { ws: ctx.ws, entry: { title, body }, posts: shipped, actorId: ctx.user.id });
      return cid;
    });
    return [201, { entry: { id, title, body, postIds } }];
  });

  // ---- admin insights -----------------------------------------------------

  router.get('/api/w/:slug/stats', (ctx) => {
    requireAdmin(ctx);
    const wsId = ctx.ws.id;
    const one = (sql) => db.prepare(sql).get(wsId).n;
    const totals = {
      posts: one('SELECT COUNT(*) AS n FROM posts WHERE workspace_id = ?'),
      votes: one('SELECT COUNT(*) AS n FROM votes v JOIN posts p ON p.id = v.post_id WHERE p.workspace_id = ?'),
      comments: one('SELECT COUNT(*) AS n FROM comments c JOIN posts p ON p.id = c.post_id WHERE p.workspace_id = ?'),
      voters: one('SELECT COUNT(DISTINCT v.user_id) AS n FROM votes v JOIN posts p ON p.id = v.post_id WHERE p.workspace_id = ?'),
    };
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM posts WHERE workspace_id = ? GROUP BY status').all(wsId)) {
      byStatus[r.status] = r.n;
    }
    // Daily activity for the last 30 days (zero-filled).
    const days = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
      days.push(d.toISOString().slice(0, 10));
    }
    const daily = (sql) => {
      const m = new Map(db.prepare(sql).all(wsId, days[0]).map((r) => [r.day, r.n]));
      return days.map((d) => m.get(d) ?? 0);
    };
    const activity = {
      days,
      posts: daily(`SELECT substr(created_at,1,10) AS day, COUNT(*) AS n FROM posts
                     WHERE workspace_id = ? AND created_at >= ? GROUP BY day`),
      votes: daily(`SELECT substr(v.created_at,1,10) AS day, COUNT(*) AS n FROM votes v
                     JOIN posts p ON p.id = v.post_id WHERE p.workspace_id = ? AND v.created_at >= ? GROUP BY day`),
    };
    // Untriaged = open, highest demand first: what the team should look at next.
    const untriaged = sortPosts(listPosts(ctx, { status: 'open' }), 'top').slice(0, 5).map((r) => postDto(r, ctx));
    return { totals, byStatus, activity, untriaged };
  });

  router.get('/api/w/:slug/export.csv', (ctx) => {
    requireAdmin(ctx);
    if (!planInfo(ctx.ws).features.csvExport) {
      throw paymentRequired('csvExport', 'CSV export is available on Pro and Business.');
    }
    const rows = db.prepare(
      `SELECT p.id, b.name AS board, p.title, p.body, p.status, u.name AS author, p.created_at,
              (SELECT COUNT(*) FROM votes v WHERE v.post_id = p.id) AS votes,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments
         FROM posts p JOIN boards b ON b.id = p.board_id JOIN users u ON u.id = p.author_id
        WHERE p.workspace_id = ? ORDER BY votes DESC, p.id`,
    ).all(ctx.ws.id);
    const header = ['id', 'board', 'title', 'body', 'status', 'votes', 'comments', 'author', 'created_at'];
    const csv = [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\r\n');
    ctx.res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${ctx.ws.slug}-feedback.csv"`,
      'Cache-Control': 'no-store',
    });
    ctx.res.end('﻿' + csv);
    return undefined;
  });

  // ---- billing (Stripe) ---------------------------------------------------

  function requireBilling() {
    if (!stripe) throw new HttpError(503, 'Billing is not configured on this server');
  }

  router.get('/api/w/:slug/billing', (ctx) => {
    requireAdmin(ctx);
    const ws = ctx.ws;
    return {
      plan: planInfo(ws),
      status: ws.plan_status,
      subscribedPlan: ws.plan,
      currentPeriodEnd: ws.current_period_end,
      cancelAtPeriodEnd: Boolean(ws.cancel_at_period_end),
      hasCustomer: Boolean(ws.stripe_customer_id),
      usage: usage(ws.id),
      plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p, available: id === 'free' || Boolean(prices[id]) })),
      billingEnabled: Boolean(stripe),
      canManage: ctx.role === 'owner',
    };
  });

  router.post('/api/w/:slug/billing/checkout', async (ctx) => {
    requireOwner(ctx);
    requireBilling();
    const b = await readJson(ctx.req);
    if (!PAID_PLANS.includes(b.plan)) throw bad('plan must be "pro" or "business"');
    const price = prices[b.plan];
    if (!price) throw new HttpError(503, `No Stripe price configured for ${b.plan}`);
    const ws = ctx.ws;
    if (effectivePlan(ws) !== 'free' && ws.stripe_subscription_id) {
      throw new HttpError(409, 'This workspace already has a subscription — use the billing portal to change it');
    }
    try {
      let customer = ws.stripe_customer_id;
      if (!customer) {
        // Idempotency key: double clicks must not create two customers.
        customer = (await stripe.createCustomer(
          { email: ctx.user.email, name: ws.name, metadata: { workspace_id: ws.id, slug: ws.slug } },
          `pb-customer-ws-${ws.id}`,
        )).id;
        db.prepare('UPDATE workspaces SET stripe_customer_id = ? WHERE id = ?').run(customer, ws.id);
      }
      const base = `${mailCfg.appUrl}/${ws.slug}/admin`;
      const session = await stripe.createCheckoutSession({
        mode: 'subscription',
        customer,
        client_reference_id: String(ws.id),
        line_items: [{ price, quantity: 1 }],
        metadata: { workspace_id: ws.id, plan: b.plan },
        subscription_data: { metadata: { workspace_id: ws.id, plan: b.plan } },
        allow_promotion_codes: true,
        billing_address_collection: 'required',
        tax_id_collection: { enabled: true },
        customer_update: { address: 'auto', name: 'auto' },
        success_url: `${base}?billing=success#billing`,
        cancel_url: `${base}?billing=cancel#billing`,
      });
      return { url: session.url };
    } catch (e) {
      if (e instanceof StripeError) throw new HttpError(502, `Payment provider error: ${e.message}`);
      throw e;
    }
  });

  router.post('/api/w/:slug/billing/portal', async (ctx) => {
    requireOwner(ctx);
    requireBilling();
    if (!ctx.ws.stripe_customer_id) throw bad('No billing account yet — choose a plan first');
    try {
      const session = await stripe.createPortalSession({
        customer: ctx.ws.stripe_customer_id,
        return_url: `${mailCfg.appUrl}/${ctx.ws.slug}/admin#billing`,
      });
      return { url: session.url };
    } catch (e) {
      if (e instanceof StripeError) throw new HttpError(502, `Payment provider error: ${e.message}`);
      throw e;
    }
  });

  function findWorkspaceForStripe(obj) {
    const metaId = Number(obj.metadata?.workspace_id);
    if (Number.isInteger(metaId) && metaId > 0) {
      const ws = q.wsById.get(metaId);
      if (ws) return ws;
    }
    if (obj.subscription || obj.object === 'subscription') {
      const subId = obj.object === 'subscription' ? obj.id : obj.subscription;
      const ws = db.prepare('SELECT * FROM workspaces WHERE stripe_subscription_id = ?').get(subId);
      if (ws) return ws;
    }
    if (obj.customer) return db.prepare('SELECT * FROM workspaces WHERE stripe_customer_id = ?').get(obj.customer) ?? null;
    return null;
  }

  const ENDED = new Set(['canceled', 'unpaid', 'incomplete_expired']);

  function applySubscription(ws, sub) {
    const item = sub.items?.data?.[0];
    const plan = planByPrice.get(item?.price?.id) ?? (PAID_PLANS.includes(sub.metadata?.plan) ? sub.metadata.plan : null);
    const periodEnd = sub.current_period_end ?? item?.current_period_end;
    const ended = ENDED.has(sub.status);
    db.prepare(
      `UPDATE workspaces SET plan = ?, plan_status = ?, stripe_subscription_id = ?,
              stripe_customer_id = COALESCE(?, stripe_customer_id), current_period_end = ?,
              cancel_at_period_end = ? WHERE id = ?`,
    ).run(
      ended || !plan ? 'free' : plan,
      sub.status,
      ended ? null : sub.id,
      sub.customer ?? null,
      periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      // Newer API versions may express a scheduled cancel only via cancel_at.
      !ended && (sub.cancel_at_period_end || sub.cancel_at) ? 1 : 0,
      ws.id,
    );
  }

  router.post('/api/stripe/webhook', async (ctx) => {
    if (!billing.webhookSecret) throw new HttpError(503, 'Stripe webhook secret not configured');
    const raw = await readRaw(ctx.req);
    let event;
    try {
      event = verifyWebhook(raw, ctx.req.headers['stripe-signature'], billing.webhookSecret);
    } catch (e) {
      throw bad(e.message);
    }
    const obj = event.data?.object ?? {};
    const handled = tx(db, () => {
      // Stripe delivers at-least-once: dedupe by event id in the same transaction.
      const fresh = db.prepare('INSERT OR IGNORE INTO stripe_events (id, type) VALUES (?, ?)').run(event.id, event.type);
      if (!fresh.changes) return 'duplicate';
      const ws = findWorkspaceForStripe(obj);
      if (!ws) return 'ignored';
      switch (event.type) {
        case 'checkout.session.completed':
          if (obj.mode !== 'subscription') return 'ignored';
          db.prepare(
            `UPDATE workspaces SET plan = ?, plan_status = 'active', stripe_customer_id = ?,
                    stripe_subscription_id = ? WHERE id = ?`,
          ).run(PAID_PLANS.includes(obj.metadata?.plan) ? obj.metadata.plan : 'pro', obj.customer, obj.subscription, ws.id);
          return 'ok';
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          // Ignore events for a subscription that has since been replaced.
          if (ws.stripe_subscription_id && ws.stripe_subscription_id !== obj.id && ENDED.has(obj.status)) return 'ignored';
          applySubscription(ws, obj);
          return 'ok';
        case 'customer.subscription.deleted':
          if (ws.stripe_subscription_id && ws.stripe_subscription_id !== obj.id) return 'ignored';
          db.prepare(
            "UPDATE workspaces SET plan = 'free', plan_status = 'canceled', stripe_subscription_id = NULL, current_period_end = NULL, cancel_at_period_end = 0 WHERE id = ?",
          ).run(ws.id);
          return 'ok';
        case 'invoice.payment_failed':
          notifyPaymentFailed(db, mailCfg, { ws });
          return 'ok';
        default:
          return 'ignored';
      }
    });
    return { received: true, result: handled };
  });

  router.get('/api/health', () => {
    db.prepare('SELECT 1').get(); // throws → 500 if the database is unusable
    return { ok: true };
  });

  // ---- static files -------------------------------------------------------

  async function serveStatic(res, pathname) {
    if (!publicDir) return false;
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    const file = join(publicDir, rel);
    if (!file.startsWith(publicDir + sep) && file !== publicDir) return false;
    const ext = extname(file);
    try {
      const data = await readFile(ext ? file : join(publicDir, 'index.html'));
      const type = MIME[ext || '.html'] ?? 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Cache-Control': ext === '.html' || !ext ? 'no-cache' : 'public, max-age=300' };
      // The widget is meant to be embedded on customer sites.
      if (rel === 'widget.js') headers['Access-Control-Allow-Origin'] = '*';
      res.writeHead(200, headers);
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }

  // ---- request handler ----------------------------------------------------

  return async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const m = router.match(req.method, url.pathname);
        if (!m) throw notFound('Unknown endpoint');
        if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
        // CSRF: every state-changing call must be JSON (forces a CORS preflight),
        // including body-less ones like vote, logout and delete.
        if (req.method !== 'GET' && req.method !== 'HEAD' && !CSRF_EXEMPT.has(url.pathname) &&
            !(req.headers['content-type'] || '').startsWith('application/json')) {
          throw new HttpError(415, 'Content-Type must be application/json');
        }
        const cookies = parseCookies(req.headers.cookie);
        const ctx = {
          req, res, url, cookies,
          params: m.params,
          ip: clientIp(req, trustProxy),
          user: userFromToken(db, cookies[SESSION_COOKIE]),
        };
        const out = await m.handler(ctx);
        if (out === undefined) return;
        const [status, body] = Array.isArray(out) ? out : [200, out];
        return sendJson(res, status, body);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (await serveStatic(res, url.pathname)) return;
      throw notFound();
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: err.message, ...(err.details ? { details: err.details } : {}) });
      }
      console.error(err);
      return sendJson(res, 500, { error: 'Internal server error' });
    }
  };
}
