// Pulseboard SPA — vanilla JS, no build step, no innerHTML with user data.

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function setProps(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
    } else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

/** h('div', {class:'x', onClick}, 'text', child) */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props && (props instanceof Node || typeof props !== 'object' || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  setProps(el, props);
  return append(el, children);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  return append(el, children);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const STATUS_LABELS = {
  open: 'Offen',
  under_review: 'In Prüfung',
  planned: 'Geplant',
  in_progress: 'In Arbeit',
  done: 'Erledigt',
  closed: 'Geschlossen',
};
const STATUSES = Object.keys(STATUS_LABELS);

function badge(status) {
  return h('span', { class: 'badge', style: { '--c': `var(--s-${status})` } }, STATUS_LABELS[status] ?? status);
}

const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const rtf = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto' });

function relTime(iso) {
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, sec] of units) if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), u);
  return 'gerade eben';
}

function timeEl(iso, fmt = 'rel') {
  return h('time', { datetime: iso, title: dateTimeFmt.format(new Date(iso)) },
    fmt === 'rel' ? relTime(iso) : dateFmt.format(new Date(iso)));
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------------------------
// Toasts & API
// ---------------------------------------------------------------------------

/** toast(msg, 'info'|'error'|'upgrade', { href, label }?) */
function toast(msg, type = 'info', action = null) {
  const el = h('div', { class: `toast ${type === 'info' ? '' : type}`, role: type === 'error' ? 'alert' : 'status' },
    h('span', msg),
    action ? h('a', { href: action.href, class: 'toast-action', onClick: () => el.remove() }, action.label) : null);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), action ? 9000 : type === 'error' ? 6000 : 3200);
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const UPGRADE_MESSAGES = {
  boards: 'Mehr Boards gibt es ab Pro.',
  admins: 'Weitere Admins gibt es ab Pro.',
  branding: 'Eigene Farben gibt es ab Pro.',
  csvExport: 'CSV-Export gibt es ab Pro.',
  workspaces: 'Im Free-Plan ist ein Workspace enthalten. Upgrade einen bestehenden Workspace, um weitere anzulegen.',
};

/** Where an "Upgrade" link should point: current workspace (if admin), else the first owned one. */
function upgradeHref() {
  if (state.ws?.role) return `/${state.ws.workspace.slug}/admin#billing`;
  const owned = state.me.workspaces.find((w) => w.role === 'owner');
  return owned ? `/${owned.slug}/admin#billing` : null;
}

async function api(method, path, body, { auth = true } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError(0, 'Netzwerkfehler – bitte Verbindung prüfen');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth) {
    const next = location.pathname + location.search;
    navigate(`/login?next=${encodeURIComponent(next)}`);
    throw new ApiError(401, 'Bitte melde dich an');
  }
  if (res.status === 402) {
    // Plan limit hit: explain in German and offer the upgrade path.
    const feature = data.details?.feature;
    const msg = UPGRADE_MESSAGES[feature] ?? data.error ?? 'Diese Funktion ist in deinem Plan nicht enthalten.';
    const href = upgradeHref();
    toast(msg, 'upgrade', href ? { href, label: 'Upgrade' } : null);
    const err = new ApiError(402, msg);
    err.handled = true;
    err.feature = feature;
    throw err;
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `Fehler ${res.status}`);
  return data;
}

/** Wraps an async action: disables the button, shows errors as toast. */
async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    if (e.status !== 401 && !e.handled) toast(e.message, 'error');
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

const state = { me: { user: null, workspaces: [] }, ws: null };

async function loadMe() {
  try {
    state.me = await api('GET', '/api/me', undefined, { auth: false });
  } catch {
    state.me = { user: null, workspaces: [] };
  }
}

async function logout() {
  await act(null, async () => {
    await api('POST', '/api/auth/logout');
    await loadMe();
    toast('Abgemeldet');
    navigate('/');
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function parseRoute(pathname) {
  const seg = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (seg.length === 0) return { view: 'landing' };
  if (seg.length === 1 && ['login', 'signup', 'new', 'account'].includes(seg[0])) return { view: seg[0] };
  const [slug, sub, id] = seg;
  if (seg.length === 1) return { view: 'board', slug };
  if (sub === 'p' && id && seg.length === 3) return { view: 'post', slug, id };
  if (seg.length === 2 && ['roadmap', 'changelog', 'admin'].includes(sub)) return { view: sub, slug };
  return { view: 'notfound' };
}

function navigate(to, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  render();
}

document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a');
  if (!a || a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || /\.\w+$/.test(url.pathname)) return;
  e.preventDefault();
  if (url.pathname + url.search !== location.pathname + location.search) {
    navigate(url.pathname + url.search + url.hash);
  } else if (url.hash) {
    history.pushState(null, '', url.hash);
    scrollToHash();
  }
});

function scrollToHash() {
  if (!location.hash) return;
  const el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (!el) return;
  // Offset by the sticky top bar, whose height varies (it wraps on mobile).
  const bar = document.getElementById('topbar')?.offsetHeight ?? 0;
  window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - bar - 12);
}
window.addEventListener('popstate', () => render());

let renderSeq = 0;

async function render() {
  const seq = ++renderSeq;
  const route = parseRoute(location.pathname);
  const main = document.getElementById('main');
  let node;
  try {
    if (route.slug) {
      state.ws = await api('GET', `/api/w/${encodeURIComponent(route.slug)}`, undefined, { auth: false });
      document.documentElement.style.setProperty('--accent', state.ws.workspace.accent);
    } else {
      state.ws = null;
      document.documentElement.style.removeProperty('--accent');
    }
    const views = { landing, login, signup, new: newWorkspace, account, board, post: postView, roadmap, changelog, admin, notfound };
    node = await views[route.view](route);
  } catch (e) {
    if (e.status === 401) return;
    node = errorView(e);
  }
  if (seq !== renderSeq) return; // a newer navigation won
  renderTopbar(route);
  main.replaceChildren(node);
  document.title = pageTitle(route);
  window.scrollTo(0, 0);
  scrollToHash();
}

function pageTitle(route) {
  const names = { roadmap: 'Roadmap', changelog: 'Changelog', admin: 'Admin', post: 'Idee', login: 'Anmelden', signup: 'Registrieren', new: 'Neuer Workspace', account: 'Konto' };
  const ws = state.ws?.workspace.name;
  const part = names[route.view];
  return [part, ws, 'Pulseboard'].filter(Boolean).join(' · ');
}

function errorView(e) {
  const msg = e.status === 404 ? 'Diese Seite gibt es nicht.' : e.message;
  return h('div', { class: 'card empty' },
    h('h1', e.status === 404 ? '404' : 'Fehler'), h('p', msg), h('a', { href: '/', class: 'btn' }, 'Zur Startseite'));
}

function notfound() {
  return errorView({ status: 404 });
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function renderTopbar(route) {
  const bar = document.getElementById('topbar');
  const { user } = state.me;
  const ws = state.ws;
  const navLink = (href, label, active) =>
    h('a', { href, 'aria-current': active ? 'page' : undefined }, label);

  let nav = null;
  if (ws) {
    const base = `/${ws.workspace.slug}`;
    nav = h('nav', { class: 'nav', 'aria-label': 'Workspace' },
      navLink(base, 'Ideen', route.view === 'board' || route.view === 'post'),
      navLink(`${base}/roadmap`, 'Roadmap', route.view === 'roadmap'),
      navLink(`${base}/changelog`, 'Changelog', route.view === 'changelog'),
      ws.role ? navLink(`${base}/admin`, 'Admin', route.view === 'admin') : null);
  }

  const next = encodeURIComponent(location.pathname + location.search);
  const userBox = user
    ? h('div', { class: 'user' },
        h('a', { href: '/account', title: `${user.email} · Konto & Benachrichtigungen`, class: 'user-link', 'aria-current': route.view === 'account' ? 'page' : undefined }, user.name),
        h('button', { class: 'btn-link', type: 'button', onClick: logout }, 'Abmelden'))
    : h('div', { class: 'user' },
        h('a', { href: `/login?next=${next}` }, 'Anmelden'),
        h('a', { href: `/signup?next=${next}`, class: 'btn btn-primary' }, 'Kostenlos starten'));

  bar.replaceChildren(h('div', { class: 'topbar-inner' },
    h('a', { href: ws ? `/${ws.workspace.slug}` : '/', class: 'brand' },
      h('img', { src: '/favicon.svg', alt: '' }),
      ws ? [ws.workspace.name, h('span', { class: 'ws-name small' }, '· Feedback')] : 'Pulseboard'),
    nav,
    h('div', { class: 'spacer' }),
    userBox));
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

function landing() {
  const { user, workspaces } = state.me;
  const features = [
    ['🗳️', 'Abstimmen statt raten', 'Kunden reichen Ideen ein und voten. Du siehst sofort, was den größten Hebel hat.'],
    ['🧭', 'Öffentliche Roadmap', 'Zeig, was geplant ist und woran ihr arbeitet – Vertrauen ohne Status-Meetings.'],
    ['📣', 'Changelog, der den Kreis schließt', 'Release veröffentlichen, verknüpfte Ideen werden automatisch „Erledigt“.'],
    ['🧠', 'Duplikat-Erkennung', 'Schon beim Tippen erscheinen ähnliche Ideen – Stimmen bündeln statt zersplittern.'],
    ['📊', 'Insights & Export', 'Aktivität, Status-Verteilung und unbearbeitete Top-Wünsche. CSV-Export inklusive.'],
    ['🧩', 'Widget in 1 Zeile', 'Feedback-Button auf jeder Website – ein Script-Tag genügt.'],
  ];
  const plans = [
    ['Free', '0 €', ['1 Workspace', '2 Boards', '1 Admin', 'Unbegrenzte Ideen & Votes', 'Roadmap & Changelog'], false],
    ['Pro', '19 €', ['10 Boards', '3 Admins', 'Eigene Farben', 'CSV-Export'], true],
    ['Business', '49 €', ['Unbegrenzte Boards', 'Unbegrenzte Admins', 'Eigene Farben & CSV-Export', 'Prioritäts-Support'], false],
  ];
  return h('div', null,
    h('section', { class: 'hero' },
      h('h1', 'Baue, was deine Kunden wirklich wollen.'),
      h('p', 'Pulseboard sammelt Feature-Wünsche, lässt Nutzer abstimmen und veröffentlicht Roadmap und Changelog – alles an einem Ort.'),
      h('div', { class: 'row' },
        user
          ? h('a', { href: '/new', class: 'btn btn-primary' }, 'Neuen Workspace anlegen')
          : h('a', { href: '/signup', class: 'btn btn-primary' }, 'Kostenlos starten'),
        h('a', { href: '#preise', class: 'btn' }, 'Preise ansehen'))),
    user && workspaces.length
      ? h('section', null,
          h('h2', 'Deine Workspaces'),
          h('div', { class: 'grid grid-3' },
            workspaces.map((w) => h('a', { href: `/${w.slug}`, class: 'card' },
              h('h3', w.name), h('span', { class: 'muted small' }, `/${w.slug} · ${w.role === 'owner' ? 'Owner' : 'Admin'}`)))))
      : null,
    h('section', null,
      h('h2', 'Alles für einen echten Feedback-Kreislauf'),
      h('div', { class: 'grid grid-3' },
        features.map(([icon, title, text]) =>
          h('div', { class: 'card feature' }, h('h3', h('span', { 'aria-hidden': 'true' }, icon), title), h('p', { class: 'muted' }, text))))),
    h('section', { id: 'preise' },
      h('h2', 'Preise'),
      h('div', { class: 'grid grid-3' },
        plans.map(([name, price, items, featured]) =>
          h('div', { class: `card price ${featured ? 'featured' : ''}` },
            h('h3', name),
            h('div', { class: 'amount' }, price, h('span', { class: 'muted small' }, ' / Monat')),
            h('ul', items.map((i) => h('li', '✓ ', i))),
            h('a', { href: user ? '/new' : '/signup', class: `btn ${featured ? 'btn-primary' : ''}` }, 'Loslegen'))))));
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function nextParam(fallback) {
  const n = new URLSearchParams(location.search).get('next');
  return n && n !== '/' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login') && !n.startsWith('/signup')
    ? n : fallback;
}

function field(label, input, hint) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
}

function login() {
  const email = h('input', { type: 'email', name: 'email', autocomplete: 'email', required: true });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { type: 'submit', class: 'btn-primary' }, 'Anmelden');
  const form = h('form', {
    class: 'card auth',
    onSubmit: (e) => {
      e.preventDefault();
      act(btn, async () => {
        await api('POST', '/api/auth/login', { email: email.value, password: password.value }, { auth: false });
        await loadMe();
        toast(`Willkommen zurück, ${state.me.user.name}!`);
        const ws = state.me.workspaces[0];
        navigate(nextParam(ws ? `/${ws.slug}` : '/new'), { replace: true });
      });
    },
  },
  h('h1', 'Anmelden'),
  field('E-Mail', email),
  field('Passwort', password),
  h('div', { class: 'row' }, btn, h('span', { class: 'muted small' }, 'Noch kein Konto? ',
    h('a', { href: `/signup${location.search}` }, 'Registrieren'))));
  return form;
}

function signup() {
  const name = h('input', { name: 'name', autocomplete: 'name', required: true, maxlength: 80 });
  const email = h('input', { type: 'email', name: 'email', autocomplete: 'email', required: true });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const btn = h('button', { type: 'submit', class: 'btn-primary' }, 'Konto erstellen');
  return h('form', {
    class: 'card auth',
    onSubmit: (e) => {
      e.preventDefault();
      act(btn, async () => {
        await api('POST', '/api/auth/signup', { name: name.value, email: email.value, password: password.value }, { auth: false });
        await loadMe();
        toast('Konto erstellt 🎉');
        navigate(nextParam('/new'), { replace: true });
      });
    },
  },
  h('h1', 'Kostenlos starten'),
  field('Name', name),
  field('E-Mail', email),
  field('Passwort', password, 'Mindestens 8 Zeichen'),
  h('div', { class: 'row' }, btn, h('span', { class: 'muted small' }, 'Schon registriert? ',
    h('a', { href: `/login${location.search}` }, 'Anmelden'))));
}

function newWorkspace() {
  if (!state.me.user) {
    navigate(`/login?next=${encodeURIComponent('/new')}`, { replace: true });
    return h('div');
  }
  let slugTouched = false;
  const name = h('input', { name: 'name', required: true, maxlength: 60, placeholder: 'z. B. Acme Cloud' });
  const slug = h('input', { name: 'slug', required: true, maxlength: 40, pattern: '[a-z0-9][a-z0-9\\-]{1,38}[a-z0-9]', placeholder: 'acme-cloud' });
  const preview = h('code');
  const update = () => { preview.textContent = `${location.origin}/${slug.value || '…'}`; };
  name.addEventListener('input', () => { if (!slugTouched) slug.value = slugify(name.value); update(); });
  slug.addEventListener('input', () => { slugTouched = true; slug.value = slugify(slug.value); update(); });
  update();
  const btn = h('button', { type: 'submit', class: 'btn-primary' }, 'Workspace anlegen');
  return h('form', {
    class: 'card auth',
    onSubmit: (e) => {
      e.preventDefault();
      act(btn, async () => {
        const { workspace } = await api('POST', '/api/workspaces', { name: name.value, slug: slug.value });
        await loadMe();
        toast('Workspace erstellt');
        navigate(`/${workspace.slug}`);
      });
    },
  },
  h('h1', 'Neuer Workspace'),
  h('p', { class: 'muted' }, 'Ein Workspace ist das öffentliche Feedback-Portal für ein Produkt.'),
  field('Produktname', name),
  field('URL', slug, h('span', 'Dein Portal: ', preview)),
  btn);
}

// ---------------------------------------------------------------------------
// Shared: vote button
// ---------------------------------------------------------------------------

function voteButton(post, { small = false } = {}) {
  const count = h('span', { class: 'count' }, String(post.votes));
  const btn = h('button', {
    type: 'button',
    class: `vote ${small ? 'sm' : ''}`,
    'aria-pressed': String(Boolean(post.hasVoted)),
    'aria-label': `Abstimmen für „${post.title}“`,
    title: post.hasVoted ? 'Stimme zurückziehen' : 'Dafür stimmen',
  }, h('span', { class: 'arrow', 'aria-hidden': 'true' }, '▲'), count);

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!state.me.user) {
      navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    const before = { voted: post.hasVoted, votes: post.votes };
    // Optimistic update
    post.hasVoted = !post.hasVoted;
    post.votes += post.hasVoted ? 1 : -1;
    sync();
    try {
      const r = await api('POST', `/api/w/${state.ws.workspace.slug}/posts/${post.id}/vote`);
      post.hasVoted = r.voted;
      post.votes = r.votes;
    } catch (err) {
      post.hasVoted = before.voted;
      post.votes = before.votes;
      if (err.status !== 401) toast(err.message, 'error');
    }
    sync();
  });

  function sync() {
    btn.setAttribute('aria-pressed', String(post.hasVoted));
    btn.title = post.hasVoted ? 'Stimme zurückziehen' : 'Dafür stimmen';
    count.textContent = String(post.votes);
  }
  return btn;
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

async function board({ slug }) {
  const { boards } = state.ws;
  const params = new URLSearchParams(location.search);
  const filter = {
    board: params.get('board') || '',
    sort: params.get('sort') || 'top',
    status: params.get('status') || '',
    q: params.get('q') || '',
  };

  const list = h('div', { class: 'post-list', 'aria-live': 'polite' });
  const total = h('span', { class: 'muted small' });

  async function loadList() {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) qs.set(k, v);
    history.replaceState(null, '', `/${slug}${qs.toString() ? `?${qs}` : ''}`);
    try {
      const { posts, total: n } = await api('GET', `/api/w/${slug}/posts?${qs}`);
      total.textContent = plural(n, 'Idee', 'Ideen');
      list.replaceChildren(...(posts.length
        ? posts.map(postRow)
        : [h('div', { class: 'card empty' }, filter.q || filter.status ? 'Keine Treffer für diese Filter.' : 'Noch keine Ideen – sei die erste Person, die etwas vorschlägt!')]));
    } catch (e) {
      if (e.status !== 401 && !e.handled) toast(e.message, 'error');
    }
  }

  function postRow(p) {
    const boardName = boards.find((b) => b.id === p.boardId)?.name;
    return h('article', { class: 'post' },
      voteButton(p),
      h('div', { class: 'post-main' },
        h('a', { href: `/${slug}/p/${p.id}`, class: 'post-title' }, p.title),
        p.body ? h('div', { class: 'post-excerpt' }, p.body) : null,
        h('div', { class: 'meta' },
          badge(p.status),
          !filter.board && boardName ? h('span', boardName) : null,
          h('span', `💬 ${p.comments}`),
          h('span', p.author.name, ' · ', timeEl(p.createdAt)))));
  }

  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Boards' });
  function renderTabs() {
    const tab = (id, label) => h('button', {
      type: 'button', class: 'tab', 'aria-pressed': String(filter.board === id),
      onClick: () => { filter.board = id; renderTabs(); loadList(); },
    }, label);
    tabs.replaceChildren(tab('', 'Alle'), ...boards.map((b) => tab(String(b.id), `${b.name} (${b.postCount})`)));
  }
  renderTabs();

  const search = h('input', { type: 'search', placeholder: 'Ideen durchsuchen…', value: filter.q, 'aria-label': 'Suche' });
  search.addEventListener('input', debounce(() => { filter.q = search.value.trim(); loadList(); }, 250));
  const sortSel = h('select', { 'aria-label': 'Sortierung', onChange: (e) => { filter.sort = e.target.value; loadList(); } },
    [['top', 'Meiste Stimmen'], ['trending', 'Im Trend'], ['new', 'Neueste']].map(([v, l]) => h('option', { value: v, selected: v === filter.sort }, l)));
  const statusSel = h('select', { 'aria-label': 'Status', onChange: (e) => { filter.status = e.target.value; loadList(); } },
    h('option', { value: '' }, 'Alle Status'),
    STATUSES.map((st) => h('option', { value: st, selected: st === filter.status }, STATUS_LABELS[st])));

  await loadList();

  return h('div', null,
    h('div', { class: 'board-head' },
      h('div', null, h('h1', 'Ideen & Wünsche'), total)),
    h('div', { class: 'layout' },
      h('div', null,
        tabs,
        h('div', { class: 'toolbar' }, search, sortSel, statusSel),
        list),
      h('aside', null, newPostForm(slug, boards, filter, async () => { renderTabs(); await loadList(); }))));
}

function newPostForm(slug, boards, filter, onCreated) {
  if (!state.me.user) {
    const next = encodeURIComponent(location.pathname);
    return h('div', { class: 'card stack' },
      h('h2', 'Eigene Idee einreichen'),
      h('p', { class: 'muted' }, 'Melde dich an, um Ideen vorzuschlagen, abzustimmen und zu kommentieren.'),
      h('div', { class: 'row' },
        h('a', { href: `/signup?next=${next}`, class: 'btn btn-primary' }, 'Registrieren'),
        h('a', { href: `/login?next=${next}`, class: 'btn' }, 'Anmelden')));
  }
  const title = h('input', { name: 'title', required: true, minlength: 3, maxlength: 140, placeholder: 'Kurz & prägnant', autocomplete: 'off' });
  const body = h('textarea', { name: 'body', maxlength: 5000, placeholder: 'Welches Problem würde das lösen?' });
  const boardSel = h('select', { name: 'board' },
    boards.map((b) => h('option', { value: b.id, selected: String(b.id) === filter.board }, b.name)));
  const similarBox = h('div', { 'aria-live': 'polite' });

  let simSeq = 0;
  const checkSimilar = debounce(async () => {
    const q = title.value.trim();
    const seq = ++simSeq;
    if (q.length < 3) { similarBox.replaceChildren(); return; }
    try {
      const { posts } = await api('GET', `/api/w/${slug}/similar?q=${encodeURIComponent(q)}`);
      if (seq !== simSeq) return;
      if (!posts.length) { similarBox.replaceChildren(); return; }
      similarBox.replaceChildren(h('div', { class: 'similar' },
        h('strong', { class: 'small' }, 'Ähnliche Ideen — vielleicht schon vorhanden?'),
        posts.map((p) => h('div', { class: 'similar-item' },
          voteButton(p, { small: true }),
          h('a', { href: `/${slug}/p/${p.id}` }, p.title),
          badge(p.status)))));
    } catch { /* suggestions are best-effort */ }
  }, 300);
  title.addEventListener('input', checkSimilar);

  const btn = h('button', { type: 'submit', class: 'btn-primary' }, 'Idee einreichen');
  const form = h('form', {
    class: 'card',
    onSubmit: (e) => {
      e.preventDefault();
      act(btn, async () => {
        const { post } = await api('POST', `/api/w/${slug}/posts`, {
          boardId: Number(boardSel.value), title: title.value, body: body.value,
        });
        form.reset();
        similarBox.replaceChildren();
        toast('Danke! Deine Idee ist online.');
        const b = state.ws.boards.find((x) => x.id === post.boardId);
        if (b) b.postCount++;
        await onCreated();
      });
    },
  },
  h('h2', 'Idee einreichen'),
  field('Titel', title),
  similarBox,
  field('Beschreibung', body),
  boards.length > 1 ? field('Board', boardSel) : null,
  btn);
  return form;
}

// ---------------------------------------------------------------------------
// Post detail
// ---------------------------------------------------------------------------

async function postView({ slug, id }) {
  const data = await api('GET', `/api/w/${slug}/posts/${encodeURIComponent(id)}`, undefined, { auth: false });
  const { post, comments, events } = data;
  const isAdmin = Boolean(state.ws.role);
  const canEdit = isAdmin || post.isMine;
  const boards = state.ws.boards;
  const reload = () => render();

  const head = h('div', { class: 'post', style: { 'box-shadow': 'none' } },
    voteButton(post),
    h('div', { class: 'post-main' },
      h('h1', { class: 'pre' }, post.title),
      h('div', { class: 'meta' },
        badge(post.status),
        h('span', boards.find((b) => b.id === post.boardId)?.name ?? ''),
        h('span', 'von ', post.author.name, ' · ', timeEl(post.createdAt)))));

  const bodyEl = post.body ? h('p', { class: 'pre' }, post.body) : h('p', { class: 'muted' }, 'Keine Beschreibung.');

  // --- edit form (author/admin)
  const editBox = h('div');
  function openEdit() {
    const t = h('input', { value: post.title, required: true, minlength: 3, maxlength: 140 });
    const b = h('textarea', { maxlength: 5000 }, post.body);
    const save = h('button', { type: 'submit', class: 'btn-primary' }, 'Speichern');
    editBox.replaceChildren(h('form', {
      class: 'card',
      onSubmit: (e) => {
        e.preventDefault();
        act(save, async () => {
          await api('PATCH', `/api/w/${slug}/posts/${post.id}`, { title: t.value, body: b.value });
          toast('Gespeichert');
          reload();
        });
      },
    }, field('Titel', t), field('Beschreibung', b),
    h('div', { class: 'row' }, save, h('button', { type: 'button', onClick: () => editBox.replaceChildren() }, 'Abbrechen'))));
  }

  // --- admin controls
  let adminBox = null;
  if (canEdit) {
    const controls = [];
    if (isAdmin) {
      const statusSel = h('select', {
        'aria-label': 'Status ändern',
        onChange: (e) => act(statusSel, async () => {
          await api('PATCH', `/api/w/${slug}/posts/${post.id}`, { status: e.target.value });
          toast(`Status: ${STATUS_LABELS[e.target.value]}`);
          reload();
        }),
      }, STATUSES.map((st) => h('option', { value: st, selected: st === post.status }, STATUS_LABELS[st])));
      const boardSel = h('select', {
        'aria-label': 'Board ändern',
        onChange: (e) => act(boardSel, async () => {
          await api('PATCH', `/api/w/${slug}/posts/${post.id}`, { boardId: Number(e.target.value) });
          toast('Board geändert');
          reload();
        }),
      }, boards.map((b) => h('option', { value: b.id, selected: b.id === post.boardId }, b.name)));
      controls.push(field('Status', statusSel));
      if (boards.length > 1) controls.push(field('Board', boardSel));
    }
    const del = h('button', {
      type: 'button', class: 'btn-danger',
      onClick: () => {
        if (!confirm('Diese Idee wirklich löschen? Stimmen und Kommentare gehen verloren.')) return;
        act(del, async () => {
          await api('DELETE', `/api/w/${slug}/posts/${post.id}`);
          toast('Gelöscht');
          navigate(`/${slug}`);
        });
      },
    }, 'Löschen');
    adminBox = h('div', { class: 'card' },
      h('h2', isAdmin ? 'Verwalten' : 'Deine Idee'),
      controls,
      h('div', { class: 'row' }, h('button', { type: 'button', onClick: openEdit }, 'Bearbeiten'), del));
  }

  // --- comments
  const commentList = h('div', null, comments.length
    ? comments.map(commentEl)
    : h('p', { class: 'muted' }, 'Noch keine Kommentare.'));

  function commentEl(c) {
    return h('div', { class: `comment ${c.isAdmin ? 'admin' : ''}` },
      h('div', { class: 'meta' },
        h('strong', { style: { color: 'var(--text)' } }, c.authorName),
        c.isAdmin ? h('span', { class: 'badge badge-admin' }, 'Team') : null,
        timeEl(c.createdAt)),
      h('div', { class: 'pre' }, c.body));
  }

  let commentForm;
  if (state.me.user) {
    const ta = h('textarea', { required: true, maxlength: 3000, placeholder: 'Was denkst du?' });
    const send = h('button', { type: 'submit', class: 'btn-primary' }, 'Kommentieren');
    commentForm = h('form', {
      onSubmit: (e) => {
        e.preventDefault();
        act(send, async () => {
          const { comment } = await api('POST', `/api/w/${slug}/posts/${post.id}/comments`, { body: ta.value });
          if (!commentList.querySelector('.comment')) commentList.replaceChildren();
          commentList.append(commentEl(comment));
          ta.value = '';
        });
      },
    }, field('Kommentar', ta), send);
  } else {
    commentForm = h('p', { class: 'muted' },
      h('a', { href: `/login?next=${encodeURIComponent(location.pathname)}` }, 'Anmelden'), ', um zu kommentieren.');
  }

  // --- timeline
  const timeline = h('ul', { class: 'timeline' },
    h('li', h('strong', 'Eingereicht'), ' von ', post.author.name, h('div', { class: 'muted small' }, timeEl(post.createdAt, 'date'))),
    events.map((ev) => h('li',
      ev.fromStatus ? [badge(ev.fromStatus), ' → '] : null, badge(ev.toStatus),
      h('div', { class: 'muted small' }, ev.actorName, ' · ', timeEl(ev.createdAt, 'date')))));

  return h('div', null,
    h('p', null, h('a', { href: `/${slug}` }, '← Alle Ideen')),
    h('div', { class: 'layout' },
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, head, bodyEl),
        editBox,
        h('div', { class: 'card' }, h('h2', `Kommentare (${comments.length})`), commentList, commentForm)),
      h('aside', { class: 'stack' },
        adminBox,
        h('div', { class: 'card' }, h('h2', 'Verlauf'), timeline))));
}

// ---------------------------------------------------------------------------
// Roadmap
// ---------------------------------------------------------------------------

async function roadmap({ slug }) {
  const { columns } = await api('GET', `/api/w/${slug}/roadmap`, undefined, { auth: false });
  return h('div', null,
    h('h1', 'Roadmap'),
    h('p', { class: 'muted' }, 'Was als Nächstes kommt – priorisiert nach euren Stimmen.'),
    h('div', { class: 'columns' },
      ['planned', 'in_progress', 'done'].map((st) => h('section', { class: 'column', 'aria-label': STATUS_LABELS[st] },
        h('h2', h('span', { class: 'dot', style: { '--c': `var(--s-${st})` } }), STATUS_LABELS[st],
          h('span', { class: 'muted small' }, `(${columns[st].length})`)),
        columns[st].length
          ? columns[st].map((p) => h('div', { class: 'mini' },
              voteButton(p, { small: true }),
              h('a', { href: `/${slug}/p/${p.id}` }, p.title)))
          : h('p', { class: 'muted small' }, 'Noch nichts hier.')))));
}

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

async function changelog({ slug }) {
  const { entries } = await api('GET', `/api/w/${slug}/changelog`, undefined, { auth: false });
  const isAdmin = Boolean(state.ws.role);

  let form = null;
  if (isAdmin) {
    const { posts } = await api('GET', `/api/w/${slug}/posts?sort=top&limit=200`);
    const candidates = posts.filter((p) => p.status !== 'done' && p.status !== 'closed');
    const title = h('input', { required: true, maxlength: 140, placeholder: 'z. B. Version 2.4' });
    const body = h('textarea', { maxlength: 10000, placeholder: 'Was ist neu?' });
    const markDone = h('input', { type: 'checkbox', checked: true, id: 'markdone' });
    const boxes = candidates.map((p) => ({ p, cb: h('input', { type: 'checkbox', value: p.id }) }));
    const pickerId = 'picker-label';
    const btn = h('button', { type: 'submit', class: 'btn-primary' }, 'Veröffentlichen');
    form = h('form', {
      class: 'card',
      onSubmit: (e) => {
        e.preventDefault();
        act(btn, async () => {
          const postIds = boxes.filter((b) => b.cb.checked).map((b) => Number(b.p.id));
          await api('POST', `/api/w/${slug}/changelog`, {
            title: title.value, body: body.value, postIds, markDone: markDone.checked,
          });
          toast('Changelog veröffentlicht');
          render();
        });
      },
    },
    h('h2', 'Neuer Eintrag'),
    field('Titel', title),
    field('Beschreibung', body),
    h('div', { class: 'field' },
      h('div', { id: pickerId, class: 'small', style: { 'font-weight': '600', 'margin-bottom': '4px' } }, 'Umgesetzte Ideen verknüpfen'),
      boxes.length
        ? h('div', { class: 'picker', role: 'group', 'aria-labelledby': pickerId },
            boxes.map(({ p, cb }) => h('label', null, cb, h('span', p.title), badge(p.status))))
        : h('p', { class: 'muted small' }, 'Keine offenen Ideen.')),
    h('div', { class: 'field' }, h('label', { class: 'check', for: 'markdone' }, markDone, 'Verknüpfte Ideen als „Erledigt“ markieren')),
    btn);
  }

  return h('div', null,
    h('h1', 'Changelog'),
    h('p', { class: 'muted' }, 'Neuigkeiten und ausgelieferte Wünsche.'),
    h('div', { class: isAdmin ? 'layout' : '' },
      h('div', { class: 'stack' },
        entries.length
          ? entries.map((e) => h('article', { class: 'card entry' },
              timeEl(e.createdAt, 'date'),
              h('h2', e.title),
              e.body ? h('p', { class: 'pre' }, e.body) : null,
              e.posts.length ? h('div', null,
                h('div', { class: 'small muted' }, 'Umgesetzt:'),
                h('ul', e.posts.map((p) => h('li', h('a', { href: `/${slug}/p/${p.id}` }, p.title))))) : null))
          : h('div', { class: 'card empty' }, 'Noch keine Einträge.')),
      form));
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

function activityChart({ days, posts, votes }) {
  const W = 600, H = 180, P = { l: 28, r: 8, t: 10, b: 22 };
  const max = Math.max(1, ...posts, ...votes);
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const step = iw / days.length;
  const y = (v) => P.t + ih - (v / max) * ih;
  const bars = votes.map((v, i) => s('rect', {
    class: 'bar', x: (P.l + i * step + 1).toFixed(1), y: y(v).toFixed(1),
    width: Math.max(1, step - 2).toFixed(1), height: (P.t + ih - y(v)).toFixed(1),
  }, s('title', {}, `${days[i]}: ${v} Stimmen`)));
  const line = posts.map((v, i) => `${i ? 'L' : 'M'}${(P.l + i * step + step / 2).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const fmt = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;
  return h('div', { class: 'chart' },
    s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Aktivität der letzten 30 Tage: ${votes.reduce((a, b) => a + b, 0)} Stimmen, ${posts.reduce((a, b) => a + b, 0)} Ideen` },
      s('line', { class: 'axis', x1: P.l, x2: W - P.r, y1: P.t + ih, y2: P.t + ih }),
      s('line', { class: 'axis', x1: P.l, x2: W - P.r, y1: P.t, y2: P.t, 'stroke-dasharray': '3 3' }),
      s('text', { x: P.l - 4, y: P.t + 4, 'text-anchor': 'end' }, String(max)),
      s('text', { x: P.l - 4, y: P.t + ih, 'text-anchor': 'end' }, '0'),
      bars,
      s('path', { class: 'line', d: line }),
      [0, 10, 20, 29].map((i) => s('text', { x: P.l + i * step + step / 2, y: H - 6, 'text-anchor': 'middle' }, fmt(days[i])))),
    h('div', { class: 'legend' },
      h('span', { style: { '--c': 'color-mix(in srgb, var(--accent) 55%, transparent)' } }, 'Stimmen'),
      h('span', { style: { '--c': 'var(--accent)' } }, 'Neue Ideen')));
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

const PLAN_STATUS_LABELS = {
  active: 'Aktiv',
  trialing: 'Testphase',
  past_due: 'Zahlung überfällig',
  canceled: 'Gekündigt',
  incomplete: 'Unvollständig',
  incomplete_expired: 'Abgelaufen',
  unpaid: 'Unbezahlt',
};
const PLAN_STATUS_COLORS = { active: 'var(--ok)', trialing: 'var(--s-planned)', past_due: 'var(--danger)' };

const proBadge = () => h('span', { class: 'pro-badge', title: 'Ab Pro verfügbar' }, 'Pro');

const limitText = (n, one, many) => (n === null || n === undefined ? `Unbegrenzte ${many}` : plural(n, one, many));

function planFeatures(p) {
  return [
    p.id === 'free' ? '1 Workspace' : null,
    limitText(p.limits.boards, 'Board', 'Boards'),
    limitText(p.limits.admins, 'Admin', 'Admins'),
    p.features.branding ? 'Eigene Farben' : null,
    p.features.csvExport ? 'CSV-Export' : null,
    p.id === 'business' ? 'Prioritäts-Support' : null,
  ].filter(Boolean);
}

function meter(label, used, limit) {
  const unlimited = limit === null || limit === undefined;
  const pct = unlimited ? 4 : Math.min(100, (used / Math.max(1, limit)) * 100);
  const full = !unlimited && used >= limit;
  return h('div', { class: 'meter' },
    h('div', { class: 'meter-head' },
      h('span', label),
      h('span', { class: 'small muted' }, unlimited ? `${used} / unbegrenzt` : `${used} / ${limit}`)),
    h('div', {
      class: `track ${full ? 'full' : ''}`, role: 'progressbar', 'aria-label': label,
      'aria-valuemin': '0', 'aria-valuemax': unlimited ? undefined : String(limit), 'aria-valuenow': String(used),
    }, h('div', { class: 'fill', style: { width: `${pct}%` } })));
}

/** Only follow http(s) redirects returned by our own API (Stripe Checkout / Portal). */
function redirectTo(url) {
  const u = new URL(url, location.href);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ApiError(0, 'Ungültige Weiterleitung');
  location.assign(u.href);
}

function billingSection(slug, billing) {
  const current = billing.plan.id;
  const paid = current !== 'free';
  const canBuy = billing.canManage && billing.billingEnabled;
  const status = billing.status;
  const showStatus = billing.subscribedPlan !== 'free' || status !== 'active';

  const checkout = (planId) => (e) => act(e.currentTarget, async () => {
    const { url } = await api('POST', `/api/w/${slug}/billing/checkout`, { plan: planId });
    redirectTo(url);
  });
  const portal = (e) => act(e.currentTarget, async () => {
    const { url } = await api('POST', `/api/w/${slug}/billing/portal`);
    redirectTo(url);
  });

  const cards = billing.plans.map((p) => {
    const isCurrent = p.id === current;
    let action = null;
    if (isCurrent) action = h('span', { class: 'badge current-plan' }, 'Aktueller Plan');
    else if (canBuy && !paid && p.id !== 'free') {
      action = p.available
        ? h('button', { type: 'button', class: 'btn-primary', onClick: checkout(p.id) }, `Upgrade auf ${p.name}`)
        : h('span', { class: 'muted small' }, 'Derzeit nicht buchbar');
    } else if (canBuy && paid && billing.hasCustomer) {
      action = h('button', { type: 'button', onClick: portal }, p.id === 'free' ? 'Kündigen' : `Zu ${p.name} wechseln`);
    }
    return h('div', { class: `card price plan-card ${isCurrent ? 'featured' : ''}` },
      h('h3', p.name),
      h('div', { class: 'amount' }, `${p.priceEur} €`, h('span', { class: 'muted small' }, ' / Monat')),
      h('ul', planFeatures(p).map((i) => h('li', '✓ ', i))),
      action);
  });

  return h('section', { id: 'billing', class: 'card stack', 'aria-labelledby': 'billing-h' },
    h('h2', { id: 'billing-h' }, 'Abo & Abrechnung'),
    status === 'past_due'
      ? h('div', { class: 'banner warn', role: 'alert' },
          h('strong', 'Zahlung überfällig. '),
          'Die letzte Abbuchung ist fehlgeschlagen – bitte aktualisiere deine Zahlungsmethode, damit die Pro-Funktionen erhalten bleiben.',
          billing.canManage && billing.hasCustomer && billing.billingEnabled
            ? h('button', { type: 'button', class: 'btn-primary', onClick: portal }, 'Zahlungsmethode aktualisieren')
            : null)
      : null,
    h('div', { class: 'row' },
      h('span', 'Aktueller Plan: ', h('strong', billing.plan.name)),
      showStatus ? h('span', { class: 'badge', style: { '--c': PLAN_STATUS_COLORS[status] ?? 'var(--muted)' } }, PLAN_STATUS_LABELS[status] ?? status) : null,
      billing.currentPeriodEnd && paid && !billing.cancelAtPeriodEnd
        ? h('span', { class: 'muted small' }, 'Aktueller Zeitraum bis ', timeEl(billing.currentPeriodEnd, 'date'))
        : null),
    billing.cancelAtPeriodEnd && paid
      ? h('div', { class: 'banner warn', role: 'status' },
          h('strong', 'Abo gekündigt. '),
          billing.currentPeriodEnd
            ? ['Dein Plan läuft am ', timeEl(billing.currentPeriodEnd, 'date'), ' aus und wechselt dann auf Free.']
            : 'Dein Plan läuft zum Ende des Abrechnungszeitraums aus.',
          billing.canManage && billing.hasCustomer && billing.billingEnabled
            ? h('button', { type: 'button', class: 'btn-primary', onClick: portal }, 'Kündigung zurücknehmen')
            : null)
      : null,
    h('div', { class: 'grid grid-2 meters' },
      meter('Boards', billing.usage.boards, billing.plan.limits.boards),
      meter('Admins', billing.usage.admins, billing.plan.limits.admins)),
    h('div', { class: 'grid grid-3' }, cards),
    h('div', { class: 'row' },
      canBuy && billing.hasCustomer && paid ? h('button', { type: 'button', onClick: portal }, 'Abo verwalten') : null,
      canBuy && billing.hasCustomer && paid ? h('span', { class: 'muted small' }, 'Rechnungen, Zahlungsmethode und Kündigung im Stripe-Kundenportal.') : null),
    !billing.billingEnabled ? h('p', { class: 'muted small' }, 'Abrechnung ist auf diesem Server nicht konfiguriert.') : null,
    billing.billingEnabled && !billing.canManage ? h('p', { class: 'muted small' }, 'Nur der Owner dieses Workspaces kann das Abo ändern.') : null);
}

/** Handles the return from Stripe Checkout (?billing=success|cancel). */
function handleCheckoutReturn(slug, billing) {
  const params = new URLSearchParams(location.search);
  const result = params.get('billing');
  if (!result) return;
  params.delete('billing');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
  if (result === 'cancel') {
    toast('Checkout abgebrochen');
    return;
  }
  if (result !== 'success') return;
  if (billing.plan.id !== 'free') {
    toast('Danke! Dein Abo ist aktiv.');
    return;
  }
  // The Stripe webhook can lag a few seconds behind the redirect.
  toast('Zahlung eingegangen – dein Abo wird aktiviert …');
  const path = location.pathname;
  let tries = 0;
  const poll = async () => {
    if (location.pathname !== path) return;
    tries++;
    try {
      const b = await api('GET', `/api/w/${slug}/billing`);
      if (b.plan.id !== 'free') {
        toast('Danke! Dein Abo ist aktiv.');
        if (location.pathname === path) render();
        return;
      }
    } catch { /* retry */ }
    if (tries < 5) setTimeout(poll, 2000);
    else toast('Die Aktivierung dauert länger als erwartet. Bitte lade die Seite gleich neu.', 'error');
  };
  setTimeout(poll, 2000);
}

async function admin({ slug }) {
  if (!state.me.user) {
    navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true });
    return h('div');
  }
  if (!state.ws.role) return h('div', { class: 'card empty' }, h('h1', 'Kein Zugriff'), h('p', 'Nur Admins dieses Workspaces sehen diese Seite.'));

  const isOwner = state.ws.role === 'owner';
  const [stats, { members }, billing] = await Promise.all([
    api('GET', `/api/w/${slug}/stats`),
    api('GET', `/api/w/${slug}/members`),
    api('GET', `/api/w/${slug}/billing`),
  ]);
  const plan = billing.plan;
  queueMicrotask(() => handleCheckoutReturn(slug, billing));
  const { totals, byStatus, activity, untriaged } = stats;

  const kpis = [['Ideen', totals.posts], ['Stimmen', totals.votes], ['Kommentare', totals.comments], ['Aktive Voter', totals.voters]];
  const maxStatus = Math.max(1, ...Object.values(byStatus));

  // settings
  const nameIn = h('input', { value: state.ws.workspace.name, required: true, maxlength: 60 });
  const canBrand = plan.features.branding;
  const accentIn = h('input', { type: 'color', value: state.ws.workspace.accent, disabled: !canBrand, 'aria-describedby': canBrand ? undefined : 'accent-hint' });
  accentIn.addEventListener('input', () => document.documentElement.style.setProperty('--accent', accentIn.value));
  const saveBtn = h('button', { type: 'submit', class: 'btn-primary' }, 'Speichern');
  const settings = h('form', {
    class: 'card',
    onSubmit: (e) => {
      e.preventDefault();
      act(saveBtn, async () => {
        await api('PATCH', `/api/w/${slug}`, { name: nameIn.value, accent: accentIn.value });
        await loadMe();
        toast('Einstellungen gespeichert');
        render();
      });
    },
  }, h('h2', 'Branding'), field('Name', nameIn),
  h('div', { class: 'field' },
    h('label', { for: (accentIn.id = 'accent-in') }, 'Akzentfarbe ', canBrand ? null : proBadge()),
    accentIn,
    canBrand ? null : h('div', { class: 'hint', id: 'accent-hint' }, 'Eigene Farben gibt es ab Pro. ', h('a', { href: '#billing' }, 'Upgrade'))),
  saveBtn);

  // boards
  const boardIn = h('input', { required: true, maxlength: 40, placeholder: 'z. B. Integrationen' });
  const boardBtn = h('button', { type: 'submit' }, 'Board anlegen');
  const boardsCard = h('form', {
    class: 'card',
    onSubmit: (e) => {
      e.preventDefault();
      act(boardBtn, async () => {
        await api('POST', `/api/w/${slug}/boards`, { name: boardIn.value });
        toast('Board angelegt');
        render();
      });
    },
  }, h('h2', 'Boards ', plan.limits.boards !== null && billing.usage.boards >= plan.limits.boards ? proBadge() : null),
  h('ul', state.ws.boards.map((b) => h('li', b.name, h('span', { class: 'muted small' }, ` · ${plural(b.postCount, 'Idee', 'Ideen')}`)))),
  field('Neues Board', boardIn,
    plan.limits.boards === null ? null : `${billing.usage.boards} von ${plan.limits.boards} Boards im ${plan.name}-Plan`),
  boardBtn);

  // members
  const memberList = h('ul', members.map((m) => h('li', m.name, ' ', h('span', { class: 'muted small' }, `${m.email} · ${m.role === 'owner' ? 'Owner' : 'Admin'}`))));
  let memberForm = null;
  if (isOwner) {
    const emailIn = h('input', { type: 'email', required: true, placeholder: 'kollegin@firma.de' });
    const addBtn = h('button', { type: 'submit' }, 'Als Admin hinzufügen');
    memberForm = h('form', {
      onSubmit: (e) => {
        e.preventDefault();
        act(addBtn, async () => {
          const { member } = await api('POST', `/api/w/${slug}/members`, { email: emailIn.value });
          memberList.append(h('li', member.name, ' ', h('span', { class: 'muted small' }, `${member.email} · ${member.role === 'owner' ? 'Owner' : 'Admin'}`)));
          emailIn.value = '';
          toast('Admin hinzugefügt');
        });
      },
    }, field('E-Mail', emailIn, plan.limits.admins !== null && billing.usage.admins >= plan.limits.admins
      ? h('span', null, proBadge(), ' Weitere Admins gibt es ab Pro. ', h('a', { href: '#billing' }, 'Upgrade'))
      : 'Die Person muss bereits ein Konto haben.'), addBtn);
  }

  // embed
  const snippet = `<script src="${location.origin}/widget.js" data-workspace="${slug}" async></script>`;
  const copyBtn = h('button', {
    type: 'button',
    onClick: async () => {
      try { await navigator.clipboard.writeText(snippet); toast('Kopiert'); } catch { toast('Kopieren nicht möglich', 'error'); }
    },
  }, 'Kopieren');

  return h('div', { class: 'stack' },
    h('div', { class: 'board-head' },
      h('h1', 'Admin & Insights'),
      plan.features.csvExport
        ? h('a', { href: `/api/w/${slug}/export.csv`, class: 'btn', download: '' }, '⬇ CSV-Export')
        : h('a', { href: '#billing', class: 'btn btn-locked', title: 'CSV-Export gibt es ab Pro' }, '⬇ CSV-Export ', proBadge())),
    h('div', { class: 'grid grid-4' },
      kpis.map(([label, value]) => h('div', { class: 'card kpi' }, h('div', { class: 'value' }, value.toLocaleString('de-DE')), h('div', { class: 'label' }, label)))),
    h('div', { class: 'grid grid-2' },
      h('div', { class: 'card' }, h('h2', 'Aktivität (30 Tage)'), activityChart(activity)),
      h('div', { class: 'card' }, h('h2', 'Status-Verteilung'),
        STATUSES.map((st) => h('div', { class: 'hbar' },
          h('span', STATUS_LABELS[st]),
          h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(byStatus[st] / maxStatus) * 100}%`, '--c': `var(--s-${st})` } })),
          h('span', { class: 'small' }, String(byStatus[st])))))),
    h('div', { class: 'card' },
      h('h2', 'Unbearbeitete Top-Wünsche'),
      h('p', { class: 'muted small' }, 'Offene Ideen mit den meisten Stimmen – hier lohnt sich die Triage.'),
      untriaged.length
        ? untriaged.map((p) => h('div', { class: 'mini' }, voteButton(p, { small: true }), h('a', { href: `/${slug}/p/${p.id}` }, p.title), h('span', { class: 'small muted' }, `💬 ${p.comments}`)))
        : h('p', { class: 'muted' }, 'Alles triagiert 🎉')),
    h('div', { class: 'grid grid-3' },
      settings,
      boardsCard,
      h('div', { class: 'card' }, h('h2', 'Team'), memberList, memberForm)),
    h('div', { class: 'card stack' },
      h('h2', 'Widget einbetten'),
      h('p', { class: 'muted' }, 'Füge diese Zeile vor </body> deiner Website ein – es erscheint ein Feedback-Button.'),
      h('code', { class: 'snippet' }, snippet),
      copyBtn),
    billingSection(slug, billing));
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

function account() {
  const { user, workspaces } = state.me;
  if (!user) {
    navigate(`/login?next=${encodeURIComponent('/account')}`, { replace: true });
    return h('div');
  }
  const nameIn = h('input', { value: user.name, required: true, maxlength: 80, autocomplete: 'name' });
  const saveBtn = h('button', { type: 'submit', class: 'btn-primary' }, 'Speichern');
  const notify = h('input', { type: 'checkbox', id: 'notify-in', checked: user.emailNotifications });
  notify.addEventListener('change', () => act(notify, async () => {
    try {
      const { user: u } = await api('PATCH', '/api/me', { emailNotifications: notify.checked });
      state.me.user = { ...state.me.user, ...u };
      toast(u.emailNotifications ? 'E-Mail-Benachrichtigungen aktiviert' : 'E-Mail-Benachrichtigungen deaktiviert');
    } catch (e) {
      notify.checked = !notify.checked;
      throw e;
    }
  }));

  return h('div', { class: 'stack narrow' },
    h('h1', 'Konto'),
    h('form', {
      class: 'card',
      onSubmit: (e) => {
        e.preventDefault();
        act(saveBtn, async () => {
          const { user: u } = await api('PATCH', '/api/me', { name: nameIn.value });
          state.me.user = { ...state.me.user, ...u };
          toast('Gespeichert');
          render();
        });
      },
    },
    h('h2', 'Profil'),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'E-Mail'), h('div', { class: 'muted' }, user.email)),
    field('Name', nameIn),
    saveBtn),
    h('div', { class: 'card' },
      h('h2', 'Benachrichtigungen'),
      h('label', { class: 'check', for: 'notify-in' }, notify,
        'E-Mail-Benachrichtigungen bei Statusänderungen, Team-Antworten und Releases'),
      h('p', { class: 'hint' }, 'Gilt für Ideen, die du eingereicht, unterstützt oder kommentiert hast. Rechnungs-E-Mails erhalten Owner unabhängig davon.')),
    workspaces.length
      ? h('div', { class: 'card' },
          h('h2', 'Deine Workspaces'),
          h('ul', workspaces.map((w) => h('li',
            h('a', { href: `/${w.slug}` }, w.name), ' ',
            h('span', { class: 'muted small' }, w.role === 'owner' ? 'Owner' : 'Admin'),
            ' · ', h('a', { href: `/${w.slug}/admin#billing`, class: 'small' }, w.role === 'owner' ? 'Abo verwalten' : 'Admin')))))
      : null);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

await loadMe();
render();
