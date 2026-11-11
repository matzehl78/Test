import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const SESSION_COOKIE = 'pb_session';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [algo, saltB64, keyB64] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: 16384, r: 8, p: 1,
  });
  return timingSafeEqual(expected, actual);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Creates a session and returns the raw token (only the hash is stored). */
export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return { token, maxAge: SESSION_TTL_MS / 1000 };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function userFromToken(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.email, u.name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(db, token);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name };
}

/** Fixed-window in-memory rate limiter (per key). */
export function rateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const e = hits.get(key);
    if (!e || e.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      }
      return true;
    }
    e.count++;
    return e.count <= limit;
  };
}
