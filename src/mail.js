// Transactional email: a DB-backed outbox (enqueue inside the same
// transaction as the triggering change) drained by a worker with retries.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Persistent secret for signing unsubscribe links (env wins, else stored in DB). */
export function getAppSecret(db, envSecret) {
  if (envSecret) return envSecret;
  const row = db.prepare("SELECT value FROM app_meta WHERE key = 'app_secret'").get();
  if (row) return row.value;
  const secret = randomBytes(32).toString('base64url');
  db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('app_secret', ?)").run(secret);
  return db.prepare("SELECT value FROM app_meta WHERE key = 'app_secret'").get().value;
}

export function unsubscribeToken(secret, userId) {
  return createHmac('sha256', secret).update(`unsubscribe:${userId}`).digest('base64url');
}

export function checkUnsubscribeToken(secret, userId, token) {
  const a = Buffer.from(unsubscribeToken(secret, userId));
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function enqueueEmail(db, { to, subject, text, html, headers = {}, kind }) {
  db.prepare(
    'INSERT INTO email_outbox (to_email, subject, text_body, html_body, headers, kind) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(to, subject, text, html, JSON.stringify(headers), kind);
}

/**
 * transport: 'log' (dev: prints to console) | 'resend' (https://resend.com HTTP API)
 * | 'memory' (tests: collects into mailer.sent).
 */
export function createMailer({ transport = 'log', from = 'Pulseboard <noreply@localhost>', apiKey, fetchImpl = fetch, logger = console } = {}) {
  const sent = [];
  async function send(msg) {
    if (transport === 'memory') {
      sent.push(msg);
      return;
    }
    if (transport === 'log') {
      logger.log(`[mail] → ${msg.to} | ${msg.subject}`);
      return;
    }
    if (transport === 'resend') {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html, headers: msg.headers }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
        err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
        throw err;
      }
      return;
    }
    throw new Error(`Unknown mail transport: ${transport}`);
  }
  return { send, sent, transport };
}

const MAX_ATTEMPTS = 6;

/** Sends due emails. Exponential backoff: 1, 2, 4, 8, 16 minutes. */
export async function processOutbox(db, mailer, { batch = 25, now = Date.now() } = {}) {
  const due = db.prepare(
    "SELECT * FROM email_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?",
  ).all(now, batch);
  let sentCount = 0;
  for (const row of due) {
    try {
      await mailer.send({
        to: row.to_email, subject: row.subject, text: row.text_body, html: row.html_body,
        headers: JSON.parse(row.headers),
      });
      db.prepare("UPDATE email_outbox SET status = 'sent', attempts = attempts + 1, sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_error = NULL WHERE id = ?")
        .run(row.id);
      sentCount++;
    } catch (err) {
      const attempts = row.attempts + 1;
      const failed = err.permanent || attempts >= MAX_ATTEMPTS;
      db.prepare('UPDATE email_outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?')
        .run(failed ? 'failed' : 'pending', attempts, now + 60_000 * 2 ** (attempts - 1), String(err.message).slice(0, 500), row.id);
    }
  }
  return { processed: due.length, sent: sentCount };
}

/** Starts a polling worker; returns a stop function. */
export function startOutboxWorker(db, mailer, { intervalMs = 5000, logger = console } = {}) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processOutbox(db, mailer);
    } catch (e) {
      logger.error('[mail] outbox worker error', e);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
