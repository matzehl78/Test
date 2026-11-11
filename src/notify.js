// Builds notification emails and enqueues them in the outbox.
// Must be called inside the transaction of the triggering change.
import { enqueueEmail, escapeHtml, unsubscribeToken } from './mail.js';

export const STATUS_LABELS = {
  open: 'Offen',
  under_review: 'In Prüfung',
  planned: 'Geplant',
  in_progress: 'In Arbeit',
  done: 'Erledigt',
  closed: 'Geschlossen',
};

/** Author, voters and commenters of the given posts who allow email, minus excluded ids. */
export function subscribers(db, postIds, excludeUserIds = []) {
  if (!postIds.length) return [];
  const ph = postIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT DISTINCT u.id, u.email, u.name FROM users u
      WHERE u.email_notifications = 1 AND u.id IN (
        SELECT author_id FROM posts WHERE id IN (${ph})
        UNION SELECT user_id FROM votes WHERE post_id IN (${ph})
        UNION SELECT author_id FROM comments WHERE post_id IN (${ph}))
      ORDER BY u.id`,
  ).all(...postIds, ...postIds, ...postIds);
  const ex = new Set(excludeUserIds);
  return rows.filter((r) => !ex.has(r.id));
}

function layout({ ws, heading, paragraphs, cta, unsubscribeUrl, accent }) {
  const color = /^#[0-9a-fA-F]{6}$/.test(accent || '') ? accent : '#5b5bd6';
  const html = `<!doctype html><html lang="de"><body style="margin:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1c1e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:12px;padding:28px">
<tr><td style="font-size:13px;color:#6e6e73;padding-bottom:12px">${escapeHtml(ws.name)} · Feedback</td></tr>
<tr><td style="font-size:20px;font-weight:600;padding-bottom:12px">${escapeHtml(heading)}</td></tr>
${paragraphs.map((p) => `<tr><td style="font-size:15px;line-height:1.5;padding-bottom:12px">${escapeHtml(p)}</td></tr>`).join('')}
${cta ? `<tr><td style="padding:8px 0 4px"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(cta.label)}</a></td></tr>` : ''}
</table>
<p style="font-size:12px;color:#8e8e93;max-width:560px">Du erhältst diese E-Mail, weil du dieser Idee gefolgt bist, für sie abgestimmt oder sie kommentiert hast.
<a href="${escapeHtml(unsubscribeUrl)}" style="color:#8e8e93">E-Mail-Benachrichtigungen abbestellen</a></p>
</td></tr></table></body></html>`;
  const text = [heading, '', ...paragraphs, '', cta ? `${cta.label}: ${cta.url}` : '', '',
    `Abbestellen: ${unsubscribeUrl}`].join('\n');
  return { html, text };
}

function send(db, cfg, user, ws, kind, subject, content) {
  const unsubscribeUrl = `${cfg.appUrl}/api/unsubscribe?u=${user.id}&t=${unsubscribeToken(cfg.secret, user.id)}`;
  const { html, text } = layout({ ws, unsubscribeUrl, accent: ws.accent, ...content });
  enqueueEmail(db, {
    to: user.email,
    subject,
    text,
    html,
    kind,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function notifyStatusChange(db, cfg, { ws, post, from, to, actorId }) {
  if (to === 'open' || from === to) return 0;
  const users = subscribers(db, [post.id], [actorId]);
  const url = `${cfg.appUrl}/${ws.slug}/p/${post.id}`;
  for (const u of users) {
    send(db, cfg, u, ws, 'status_change', `${STATUS_LABELS[to]}: ${truncate(post.title, 80)}`, {
      heading: `Neuer Status: ${STATUS_LABELS[to]}`,
      paragraphs: [
        `Hallo ${u.name},`,
        `die Idee „${post.title}“ hat einen neuen Status: ${STATUS_LABELS[from] ?? from} → ${STATUS_LABELS[to]}.`,
      ],
      cta: { label: 'Idee ansehen', url },
    });
  }
  return users.length;
}

export function notifyAdminComment(db, cfg, { ws, post, comment, actor }) {
  const users = subscribers(db, [post.id], [actor.id]);
  const url = `${cfg.appUrl}/${ws.slug}/p/${post.id}`;
  for (const u of users) {
    send(db, cfg, u, ws, 'admin_comment', `Antwort des Teams: ${truncate(post.title, 80)}`, {
      heading: `${ws.name} hat geantwortet`,
      paragraphs: [`Hallo ${u.name},`, `${actor.name} zu „${post.title}“:`, truncate(comment, 1500)],
      cta: { label: 'Zur Diskussion', url },
    });
  }
  return users.length;
}

/** One email per user per changelog entry, listing the shipped ideas they care about. */
export function notifyChangelog(db, cfg, { ws, entry, posts, actorId }) {
  if (!posts.length) return 0;
  const byUser = new Map();
  for (const p of posts) {
    for (const u of subscribers(db, [p.id], [actorId])) {
      if (!byUser.has(u.id)) byUser.set(u.id, { user: u, posts: [] });
      byUser.get(u.id).posts.push(p);
    }
  }
  for (const { user, posts: ps } of byUser.values()) {
    send(db, cfg, user, ws, 'changelog', `Ausgeliefert: ${truncate(entry.title, 80)}`, {
      heading: `Neu bei ${ws.name}: ${entry.title}`,
      paragraphs: [
        `Hallo ${user.name},`,
        ps.length === 1
          ? `eine Idee, die dir wichtig war, ist jetzt umgesetzt: „${ps[0].title}“.`
          : `${ps.length} Ideen, die dir wichtig waren, sind jetzt umgesetzt: ${ps.map((p) => `„${p.title}“`).join(', ')}.`,
        ...(entry.body ? [truncate(entry.body, 1500)] : []),
      ],
      cta: { label: 'Changelog lesen', url: `${cfg.appUrl}/${ws.slug}/changelog` },
    });
  }
  return byUser.size;
}

export function notifyPaymentFailed(db, cfg, { ws }) {
  const owners = db.prepare(
    `SELECT u.id, u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND m.role = 'owner'`,
  ).all(ws.id);
  for (const u of owners) {
    // Billing mails are transactional: sent regardless of the notification opt-out.
    send(db, cfg, u, ws, 'payment_failed', `Zahlung fehlgeschlagen – ${ws.name}`, {
      heading: 'Deine Zahlung ist fehlgeschlagen',
      paragraphs: [
        `Hallo ${u.name},`,
        `die letzte Abbuchung für den Workspace „${ws.name}“ konnte nicht durchgeführt werden. Wir versuchen es automatisch erneut.`,
        'Bitte prüfe deine Zahlungsmethode, damit deine Pro-Funktionen erhalten bleiben.',
      ],
      cta: { label: 'Zahlungsmethode aktualisieren', url: `${cfg.appUrl}/${ws.slug}/admin#billing` },
    });
  }
  return owners.length;
}
