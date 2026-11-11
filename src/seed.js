// Demo data for Pulseboard. Idempotent: re-running does not duplicate data.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openDb, tx } from './db.js';
import { hashPassword } from './auth.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = process.env.DB_FILE || join(root, 'data', 'pulseboard.db');

const DEMO = { email: 'demo@pulseboard.dev', name: 'Demo Admin', password: 'demo1234' };
const WS = { slug: 'acme-cloud', name: 'Acme Cloud' };

const FAKE_USERS = [
  'Lena Krüger', 'Tom Becker', 'Sofia Rossi', 'Jonas Weber',
  'Aylin Demir', 'Marc Dubois', 'Priya Nair', 'Felix Wagner',
].map((name) => ({ name, email: `${name.split(' ')[0].toLowerCase()}@example.com` }));

// [board, title, body, status, voterCount, daysAgo]
const POSTS = [
  ['Feature Requests', 'Dark mode for the dashboard', 'Working late, the bright UI is painful. A system-aware dark theme would be great.', 'in_progress', 8, 40],
  ['Feature Requests', 'Slack notifications for new alerts', 'Post a message to a channel whenever an alert fires.', 'planned', 7, 35],
  ['Feature Requests', 'Single Sign-On (SAML / Okta)', 'Required by our security team before we can roll out company-wide.', 'planned', 6, 60],
  ['Feature Requests', 'Export reports as PDF', 'We send monthly reports to management, PDF would save hours.', 'done', 5, 90],
  ['Feature Requests', 'Two-factor authentication', 'TOTP-based 2FA for all accounts.', 'done', 8, 120],
  ['Feature Requests', 'Public API with API keys', 'We want to sync data into our data warehouse.', 'under_review', 6, 20],
  ['Feature Requests', 'Custom fields on projects', 'Let us add our own metadata like cost center.', 'open', 4, 12],
  ['Feature Requests', 'Mobile app for iOS and Android', 'Quick access on the go, at least read-only.', 'open', 5, 8],
  ['Feature Requests', 'Bulk edit for tasks', 'Select many tasks and change assignee or due date at once.', 'open', 3, 5],
  ['Feature Requests', 'German translation of the UI', 'Our field staff would prefer a German interface.', 'under_review', 2, 3],
  ['Feature Requests', 'Zapier integration', '', 'closed', 1, 150],
  ['Bugs', 'CSV import fails with semicolon separators', 'Excel in DE locale exports with ";" and the import rejects it.', 'in_progress', 4, 6],
  ['Bugs', 'Timezone wrong in weekly digest email', 'Digest shows UTC instead of my configured timezone.', 'planned', 3, 15],
  ['Bugs', 'Search does not find archived items', '', 'open', 2, 2],
  ['Bugs', 'Sidebar overlaps content on small laptops', 'At 1280px width the sidebar covers the table.', 'done', 2, 70],
];

const COMMENTS = [
  ['Dark mode for the dashboard', 'Lena Krüger', 'Yes please! My eyes thank you in advance.', false],
  ['Dark mode for the dashboard', DEMO.name, 'We started on this — expect a beta in the next release.', true],
  ['Single Sign-On (SAML / Okta)', 'Marc Dubois', 'Azure AD support would be important for us too.', false],
  ['Single Sign-On (SAML / Okta)', DEMO.name, 'Planned for Q1, Okta and Azure AD first.', true],
  ['CSV import fails with semicolon separators', 'Felix Wagner', 'Same here, workaround: replace ; with , before uploading.', false],
  ['Public API with API keys', 'Priya Nair', 'A webhook for changes would cover 80% of our use case.', false],
];

const CHANGELOG = [
  ['Two-factor authentication is live', 'Secure your account with any TOTP app. Enable it under Settings → Security.', ['Two-factor authentication'], 100],
  ['Reports as PDF & layout fixes', 'Download any report as a PDF. Also fixed the sidebar on smaller screens.', ['Export reports as PDF', 'Sidebar overlaps content on small laptops'], 30],
];

const iso = (daysAgo, jitterH = 0) => new Date(Date.now() - daysAgo * 864e5 + jitterH * 36e5).toISOString();

export function seed(db) {
  return tx(db, () => {
    const userId = (u, password) => {
      const row = db.prepare('SELECT id FROM users WHERE email = ?').get(u.email);
      if (row) return row.id;
      return Number(
        db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
          .run(u.email, u.name, hashPassword(password ?? 'not-a-real-login-' + Math.random())).lastInsertRowid,
      );
    };
    const demoId = userId(DEMO, DEMO.password);
    const fakeIds = FAKE_USERS.map((u) => userId(u));
    const idByName = new Map([[DEMO.name, demoId], ...FAKE_USERS.map((u, i) => [u.name, fakeIds[i]])]);

    if (db.prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(WS.slug)) {
      return { created: false };
    }

    const wsId = Number(db.prepare('INSERT INTO workspaces (slug, name) VALUES (?, ?)').run(WS.slug, WS.name).lastInsertRowid);
    db.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(wsId, demoId);
    const boards = new Map();
    for (const name of ['Feature Requests', 'Bugs']) {
      boards.set(name, Number(db.prepare('INSERT INTO boards (workspace_id, name) VALUES (?, ?)').run(wsId, name).lastInsertRowid));
    }

    const postIds = new Map();
    POSTS.forEach(([board, title, body, status, voters, daysAgo], i) => {
      const author = fakeIds[i % fakeIds.length];
      const pid = Number(
        db.prepare('INSERT INTO posts (workspace_id, board_id, author_id, title, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(wsId, boards.get(board), author, title, body, status, iso(daysAgo)).lastInsertRowid,
      );
      postIds.set(title, pid);
      const voterIds = [author, ...fakeIds.filter((id) => id !== author)].slice(0, voters);
      voterIds.forEach((uid, k) => {
        db.prepare('INSERT INTO votes (post_id, user_id, created_at) VALUES (?, ?, ?)')
          .run(pid, uid, iso(Math.max(0, daysAgo - k * 2), k));
      });
      if (status !== 'open') {
        db.prepare('INSERT INTO post_events (post_id, actor_id, from_status, to_status, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(pid, demoId, 'open', status, iso(Math.max(0, daysAgo - 1)));
      }
    });

    COMMENTS.forEach(([title, author, body, isAdmin], i) => {
      db.prepare('INSERT INTO comments (post_id, author_id, body, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(postIds.get(title), idByName.get(author), body, isAdmin ? 1 : 0, iso(1, i));
    });

    for (const [title, body, linked, daysAgo] of CHANGELOG) {
      const cid = Number(
        db.prepare('INSERT INTO changelog (workspace_id, title, body, created_at) VALUES (?, ?, ?, ?)')
          .run(wsId, title, body, iso(daysAgo)).lastInsertRowid,
      );
      for (const t of linked) {
        db.prepare('INSERT INTO changelog_posts (changelog_id, post_id) VALUES (?, ?)').run(cid, postIds.get(t));
      }
    }
    return { created: true };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb(DB_FILE);
  const { created } = seed(db);
  db.close();
  console.log(
    created
      ? `Demo-Daten angelegt in ${DB_FILE}`
      : `Workspace "${WS.slug}" existiert bereits – nichts geändert (${DB_FILE})`,
  );
  console.log(`Login: ${DEMO.email} / ${DEMO.password}  →  http://localhost:3000/${WS.slug}`);
}
