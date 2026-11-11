import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import {
  signPayload, verifyWebhook, formEncode, createStripeClient, StripeError,
} from '../src/stripe.js';
import { effectivePlan, withinLimit } from '../src/plans.js';

const SECRET = 'whsec_billing';
const PRICES = { pro: 'price_pro', business: 'price_biz' };
const APP_URL = 'https://pb.example';

function mockStripe() {
  const calls = { customers: [], checkouts: [], portals: [] };
  let n = 0;
  return {
    calls,
    createCustomer: async (params, key) => {
      calls.customers.push({ params, key });
      return { id: `cus_mock_${++n}` };
    },
    createCheckoutSession: async (params) => {
      calls.checkouts.push(params);
      return { url: `https://checkout.stripe.test/${calls.checkouts.length}` };
    },
    createPortalSession: async (params) => {
      calls.portals.push(params);
      return { url: 'https://billing.stripe.test/portal' };
    },
  };
}

function start({ stripe = mockStripe(), billing = { webhookSecret: SECRET, prices: PRICES } } = {}) {
  const db = openDb();
  const srv = createServer(createApp({ db, authRateLimit: 1000, appUrl: APP_URL, stripe, billing }));
  return new Promise((r) => srv.listen(0, () => {
    const base = `http://localhost:${srv.address().port}`;
    r({ srv, db, base, stripe });
  }));
}

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
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text };
  };
}

let n = 0;
async function newUser(base) {
  const c = client(base);
  c.email = `b${++n}@example.com`;
  const r = await c('POST', '/api/auth/signup', { email: c.email, name: `User ${n}`, password: 'password123' });
  assert.equal(r.status, 201);
  return c;
}

async function newWorkspace(c, prefix = 'ws') {
  const slug = `${prefix}-${++n}`;
  assert.equal((await c('POST', '/api/workspaces', { name: slug, slug })).status, 201);
  return slug;
}

const wsId = (db, slug) => db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug).id;
const wsRow = (db, slug) => db.prepare('SELECT * FROM workspaces WHERE slug = ?').get(slug);

let evt = 0;
async function webhook(base, event, opts = {}) {
  const { secret = SECRET, t = Math.floor(Date.now() / 1000) } = opts;
  const raw = JSON.stringify({ id: `evt_${++evt}`, ...event });
  // header: undefined → valid signature, null → no header, string → used verbatim
  const sig = opts.header === undefined ? `t=${t},v1=${signPayload(raw, secret, t)}` : opts.header;
  const headers = { 'content-type': 'application/json' };
  if (sig !== null) headers['stripe-signature'] = sig;
  const res = await fetch(`${base}/api/stripe/webhook`, { method: 'POST', headers, body: raw });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, raw };
}

const checkoutCompleted = (id, plan = 'pro', sub = `sub_${id}`) => ({
  type: 'checkout.session.completed',
  data: { object: {
    object: 'checkout.session', mode: 'subscription', client_reference_id: String(id),
    customer: `cus_${id}`, subscription: sub, metadata: { workspace_id: String(id), plan },
  } },
});

const subscriptionEvent = (type, id, { sub = `sub_${id}`, status = 'active', price = PRICES.pro, periodEnd, extra = {} } = {}) => ({
  type,
  data: { object: {
    ...extra,
    object: 'subscription', id: sub, customer: `cus_${id}`, status,
    metadata: { workspace_id: String(id) },
    items: { data: [{ price: { id: price }, ...(periodEnd ? { current_period_end: periodEnd } : {}) }] },
  } },
});

// ---------------------------------------------------------------------------

describe('free plan limits', () => {
  let s;
  before(async () => (s = await start()));
  after(() => s.srv.close());

  test('second owned free workspace → 402 with upgrade details', async () => {
    const u = await newUser(s.base);
    await newWorkspace(u);
    const r = await u('POST', '/api/workspaces', { name: 'Second', slug: `second-${++n}` });
    assert.equal(r.status, 402);
    assert.equal(typeof r.body.error, 'string');
    assert.deepEqual(r.body.details, { feature: 'workspaces', upgrade: true });
  });

  test('after upgrading, a second (free) workspace is allowed, a third free one is not', async () => {
    const u = await newUser(s.base);
    const slug = await newWorkspace(u);
    assert.equal((await webhook(s.base, checkoutCompleted(wsId(s.db, slug)))).status, 200);
    await newWorkspace(u);
    const third = await u('POST', '/api/workspaces', { name: 'Third', slug: `third-${++n}` });
    assert.equal(third.status, 402);
  });

  test('3rd board, accent, CSV, 2nd admin → 402; name change OK', async () => {
    const owner = await newUser(s.base);
    const other = await newUser(s.base);
    const slug = await newWorkspace(owner);

    const board = await owner('POST', `/api/w/${slug}/boards`, { name: 'Third' });
    assert.equal(board.status, 402);
    assert.deepEqual(board.body.details, { feature: 'boards', upgrade: true });

    const accent = await owner('PATCH', `/api/w/${slug}`, { accent: '#ff0000' });
    assert.equal(accent.status, 402);
    assert.deepEqual(accent.body.details, { feature: 'branding', upgrade: true });

    // Same accent (unchanged) plus a new name is fine on Free.
    const rename = await owner('PATCH', `/api/w/${slug}`, { name: 'Renamed', accent: '#5B5BD6' });
    assert.equal(rename.status, 200);
    assert.equal(rename.body.workspace.name, 'Renamed');

    const csv = await owner('GET', `/api/w/${slug}/export.csv`);
    assert.equal(csv.status, 402);
    assert.deepEqual(csv.body.details, { feature: 'csvExport', upgrade: true });

    const admin = await owner('POST', `/api/w/${slug}/members`, { email: other.email });
    assert.equal(admin.status, 402);
    assert.deepEqual(admin.body.details, { feature: 'admins', upgrade: true });
    // Re-adding an existing member (the owner) is not blocked by the limit.
    assert.equal((await owner('POST', `/api/w/${slug}/members`, { email: owner.email })).status, 201);
  });

  test('GET /api/w/:slug exposes plan only to admins', async () => {
    const owner = await newUser(s.base);
    const slug = await newWorkspace(owner);
    assert.equal((await owner('GET', `/api/w/${slug}`)).body.plan.id, 'free');
    assert.equal((await client(s.base)('GET', `/api/w/${slug}`)).body.plan, undefined);
  });
});

describe('billing endpoints', () => {
  let s;
  before(async () => (s = await start()));
  after(() => s.srv.close());

  test('GET /billing shape and admin-only access', async () => {
    const owner = await newUser(s.base);
    const slug = await newWorkspace(owner);
    const r = await owner('GET', `/api/w/${slug}/billing`);
    assert.equal(r.status, 200);
    const b = r.body;
    assert.equal(b.plan.id, 'free');
    assert.equal(b.status, 'active');
    assert.equal(b.subscribedPlan, 'free');
    assert.equal(b.currentPeriodEnd, null);
    assert.equal(b.cancelAtPeriodEnd, false);
    assert.equal(b.hasCustomer, false);
    assert.deepEqual(b.usage, { boards: 2, admins: 1 });
    assert.deepEqual(b.plans.map((p) => p.id), ['free', 'pro', 'business']);
    assert.ok(b.plans.every((p) => p.available));
    assert.equal(b.billingEnabled, true);
    assert.equal(b.canManage, true);
    assert.equal(b.plans[1].limits.boards, 10);
    assert.equal(b.plans[2].limits.boards, null);

    assert.equal((await client(s.base)('GET', `/api/w/${slug}/billing`)).status, 401);
    assert.equal((await (await newUser(s.base))('GET', `/api/w/${slug}/billing`)).status, 403);
  });

  test('checkout: owner-only, plan validation, Stripe params, customer created once', async () => {
    const owner = await newUser(s.base);
    const slug = await newWorkspace(owner);
    const id = wsId(s.db, slug);

    assert.equal((await owner('POST', `/api/w/${slug}/billing/checkout`, { plan: 'gold' })).status, 400);
    assert.equal((await owner('POST', `/api/w/${slug}/billing/checkout`, { plan: 'free' })).status, 400);
    assert.equal((await client(s.base)('POST', `/api/w/${slug}/billing/checkout`, { plan: 'pro' })).status, 401);
    assert.equal((await (await newUser(s.base))('POST', `/api/w/${slug}/billing/checkout`, { plan: 'pro' })).status, 403);

    const before = s.stripe.calls.customers.length;
    const r1 = await owner('POST', `/api/w/${slug}/billing/checkout`, { plan: 'pro' });
    assert.equal(r1.status, 200);
    assert.match(r1.body.url, /^https:\/\/checkout\.stripe\.test\//);
    const r2 = await owner('POST', `/api/w/${slug}/billing/checkout`, { plan: 'business' });
    assert.equal(r2.status, 200);

    assert.equal(s.stripe.calls.customers.length, before + 1, 'customer created exactly once');
    const cus = s.stripe.calls.customers.at(-1);
    assert.equal(cus.key, `pb-customer-ws-${id}`);
    assert.equal(cus.params.email, owner.email);
    assert.equal(String(cus.params.metadata.workspace_id), String(id));
    assert.ok(wsRow(s.db, slug).stripe_customer_id.startsWith('cus_mock_'));

    const [pro, biz] = s.stripe.calls.checkouts.slice(-2);
    assert.equal(pro.mode, 'subscription');
    assert.equal(pro.customer, wsRow(s.db, slug).stripe_customer_id);
    assert.equal(biz.customer, pro.customer);
    assert.equal(pro.client_reference_id, String(id));
    assert.deepEqual(pro.line_items, [{ price: 'price_pro', quantity: 1 }]);
    assert.deepEqual(biz.line_items, [{ price: 'price_biz', quantity: 1 }]);
    assert.equal(String(pro.metadata.workspace_id), String(id));
    assert.equal(pro.metadata.plan, 'pro');
    assert.equal(String(pro.subscription_data.metadata.workspace_id), String(id));
    assert.equal(pro.success_url, `${APP_URL}/${slug}/admin?billing=success#billing`);
    assert.equal(pro.cancel_url, `${APP_URL}/${slug}/admin?billing=cancel#billing`);
  });

  test('checkout: admin (non-owner) 403, already subscribed 409', async () => {
    const owner = await newUser(s.base);
    const admin = await newUser(s.base);
    const slug = await newWorkspace(owner);
    await webhook(s.base, checkoutCompleted(wsId(s.db, slug)));
    assert.equal((await owner('POST', `/api/w/${slug}/members`, { email: admin.email })).status, 201);
    assert.equal((await admin('POST', `/api/w/${slug}/billing/checkout`, { plan: 'pro' })).status, 403);
    assert.equal((await admin('POST', `/api/w/${slug}/billing/portal`)).status, 403);
    assert.equal((await admin('GET', `/api/w/${slug}/billing`)).body.canManage, false);
    assert.equal((await owner('POST', `/api/w/${slug}/billing/checkout`, { plan: 'business' })).status, 409);
  });

  test('portal requires a Stripe customer', async () => {
    const owner = await newUser(s.base);
    const slug = await newWorkspace(owner);
    assert.equal((await owner('POST', `/api/w/${slug}/billing/portal`)).status, 400);
    await owner('POST', `/api/w/${slug}/billing/checkout`, { plan: 'pro' });
    const r = await owner('POST', `/api/w/${slug}/billing/portal`);
    assert.equal(r.status, 200);
    assert.equal(r.body.url, 'https://billing.stripe.test/portal');
    const call = s.stripe.calls.portals.at(-1);
    assert.equal(call.customer, wsRow(s.db, slug).stripe_customer_id);
    assert.equal(call.return_url, `${APP_URL}/${slug}/admin#billing`);
  });

  test('Stripe errors map to 502', async () => {
    const failing = mockStripe();
    failing.createCustomer = async () => { throw new StripeError('card_declined', 402); };
    const s2 = await start({ stripe: failing });
    try {
      const owner = await newUser(s2.base);
      const slug = await newWorkspace(owner);
      const r = await owner('POST', `/api/w/${slug}/billing/checkout`, { plan: 'pro' });
      assert.equal(r.status, 502);
      assert.match(r.body.error, /card_declined/);
    } finally {
      s2.srv.close();
    }
  });
});

describe('billing disabled', () => {
  let s;
  before(async () => (s = await start({ stripe: null, billing: {} })));
  after(() => s.srv.close());

  test('checkout/portal 503, webhook 503 without secret, billing info says disabled', async () => {
    const owner = await newUser(s.base);
    const slug = await newWorkspace(owner);
    assert.equal((await owner('POST', `/api/w/${slug}/billing/checkout`, { plan: 'pro' })).status, 503);
    assert.equal((await owner('POST', `/api/w/${slug}/billing/portal`)).status, 503);
    const info = (await owner('GET', `/api/w/${slug}/billing`)).body;
    assert.equal(info.billingEnabled, false);
    assert.deepEqual(info.plans.map((p) => p.available), [true, false, false]);
    assert.equal((await webhook(s.base, checkoutCompleted(wsId(s.db, slug)))).status, 503);
  });

  test('stripe configured but price missing → 503 for that plan', async () => {
    const s2 = await start({ billing: { webhookSecret: SECRET, prices: { pro: 'price_pro' } } });
    try {
      const owner = await newUser(s2.base);
      const slug = await newWorkspace(owner);
      assert.equal((await owner('POST', `/api/w/${slug}/billing/checkout`, { plan: 'business' })).status, 503);
      assert.equal((await owner('POST', `/api/w/${slug}/billing/checkout`, { plan: 'pro' })).status, 200);
    } finally {
      s2.srv.close();
    }
  });
});

describe('stripe webhook', () => {
  let s;
  before(async () => (s = await start()));
  after(() => s.srv.close());

  async function freshWs() {
    const owner = await newUser(s.base);
    const slug = await newWorkspace(owner);
    return { owner, slug, id: wsId(s.db, slug) };
  }
  const planOf = async (owner, slug) => (await owner('GET', `/api/w/${slug}/billing`)).body;

  test('signature checks: missing, invalid, wrong secret, stale timestamp', async () => {
    const { id } = await freshWs();
    assert.equal((await webhook(s.base, checkoutCompleted(id), { header: null })).status, 400);
    assert.equal((await webhook(s.base, checkoutCompleted(id), { header: 't=123,v1=deadbeef' })).status, 400);
    assert.equal((await webhook(s.base, checkoutCompleted(id), { secret: 'whsec_wrong' })).status, 400);
    const stale = await webhook(s.base, checkoutCompleted(id), { t: Math.floor(Date.now() / 1000) - 3600 });
    assert.equal(stale.status, 400);
    assert.match(stale.body.error, /tolerance/);
  });

  test('checkout.session.completed → pro; replay is a no-op', async () => {
    const { owner, slug, id } = await freshWs();
    const raw = JSON.stringify({ id: 'evt_replay_1', ...checkoutCompleted(id) });
    const send = () => {
      const t = Math.floor(Date.now() / 1000);
      return fetch(`${s.base}/api/stripe/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${signPayload(raw, SECRET, t)}` },
        body: raw,
      }).then((r) => r.json());
    };
    assert.deepEqual(await send(), { received: true, result: 'ok' });
    assert.deepEqual(await send(), { received: true, result: 'duplicate' });
    const info = await planOf(owner, slug);
    assert.equal(info.plan.id, 'pro');
    assert.equal(info.hasCustomer, true);
    const row = wsRow(s.db, slug);
    assert.equal(row.stripe_subscription_id, `sub_${id}`);
    assert.equal(row.stripe_customer_id, `cus_${id}`);
  });

  test('subscription.updated: business price, period end, past_due grace, unpaid → free', async () => {
    const { owner, slug, id } = await freshWs();
    await webhook(s.base, checkoutCompleted(id));
    const periodEnd = 1_900_000_000;
    const up = await webhook(s.base, subscriptionEvent('customer.subscription.updated', id, { price: PRICES.business, periodEnd }));
    assert.equal(up.body.result, 'ok');
    let info = await planOf(owner, slug);
    assert.equal(info.plan.id, 'business');
    assert.equal(info.currentPeriodEnd, new Date(periodEnd * 1000).toISOString());

    await webhook(s.base, subscriptionEvent('customer.subscription.updated', id, { price: PRICES.business, status: 'past_due' }));
    info = await planOf(owner, slug);
    assert.equal(info.plan.id, 'business', 'past_due keeps entitlements');
    assert.equal(info.status, 'past_due');

    await webhook(s.base, subscriptionEvent('customer.subscription.updated', id, { price: PRICES.business, status: 'unpaid' }));
    info = await planOf(owner, slug);
    assert.equal(info.plan.id, 'free');
    assert.equal(wsRow(s.db, slug).stripe_subscription_id, null);
  });

  test('subscription.created with status incomplete grants nothing yet', async () => {
    const { owner, slug, id } = await freshWs();
    await webhook(s.base, subscriptionEvent('customer.subscription.created', id, { status: 'incomplete' }));
    assert.equal((await planOf(owner, slug)).plan.id, 'free');
    await webhook(s.base, subscriptionEvent('customer.subscription.updated', id, { status: 'active' }));
    assert.equal((await planOf(owner, slug)).plan.id, 'pro');
  });

  test('scheduled cancellation: cancel_at_period_end / cancel_at → cancelAtPeriodEnd, reset on resume and delete', async () => {
    const { owner, slug, id } = await freshWs();
    await webhook(s.base, checkoutCompleted(id));
    let info = await planOf(owner, slug);
    assert.equal(info.cancelAtPeriodEnd, false);

    await webhook(s.base, subscriptionEvent('customer.subscription.updated', id, { extra: { cancel_at_period_end: true } }));
    info = await planOf(owner, slug);
    assert.equal(info.cancelAtPeriodEnd, true);
    assert.equal(info.plan.id, 'pro', 'still entitled until period end');

    // Customer resumes in the portal.
    await webhook(s.base, subscriptionEvent('customer.subscription.updated', id, { extra: { cancel_at_period_end: false, cancel_at: null } }));
    assert.equal((await planOf(owner, slug)).cancelAtPeriodEnd, false);

    // Newer API versions only set cancel_at.
    await webhook(s.base, subscriptionEvent('customer.subscription.updated', id, { extra: { cancel_at_period_end: false, cancel_at: 1_900_000_000 } }));
    assert.equal((await planOf(owner, slug)).cancelAtPeriodEnd, true);

    // An ended subscription is not "cancelling" any more.
    await webhook(s.base, subscriptionEvent('customer.subscription.updated', id, { status: 'canceled', extra: { cancel_at_period_end: true } }));
    info = await planOf(owner, slug);
    assert.equal(info.cancelAtPeriodEnd, false);
    assert.equal(info.plan.id, 'free');

    const { slug: slug2, owner: owner2, id: id2 } = await freshWs();
    await webhook(s.base, checkoutCompleted(id2));
    await webhook(s.base, subscriptionEvent('customer.subscription.updated', id2, { extra: { cancel_at_period_end: true } }));
    await webhook(s.base, subscriptionEvent('customer.subscription.deleted', id2, { status: 'canceled', extra: { cancel_at_period_end: true } }));
    assert.equal((await planOf(owner2, slug2)).cancelAtPeriodEnd, false);
  });

  test('subscription.deleted → free', async () => {
    const { owner, slug, id } = await freshWs();
    await webhook(s.base, checkoutCompleted(id));
    const r = await webhook(s.base, subscriptionEvent('customer.subscription.deleted', id, { status: 'canceled' }));
    assert.equal(r.body.result, 'ok');
    const info = await planOf(owner, slug);
    assert.equal(info.plan.id, 'free');
    assert.equal(info.status, 'canceled');
    assert.equal(wsRow(s.db, slug).stripe_subscription_id, null);
  });

  test('deleted event for an old, replaced subscription is ignored', async () => {
    const { owner, slug, id } = await freshWs();
    await webhook(s.base, checkoutCompleted(id, 'pro', 'sub_new'));
    const r = await webhook(s.base, subscriptionEvent('customer.subscription.deleted', id, { sub: 'sub_old', status: 'canceled' }));
    assert.equal(r.body.result, 'ignored');
    assert.equal((await planOf(owner, slug)).plan.id, 'pro');
    assert.equal(wsRow(s.db, slug).stripe_subscription_id, 'sub_new');
  });

  test('events for unknown workspaces and unknown types are ignored', async () => {
    const unknown = await webhook(s.base, {
      type: 'customer.subscription.updated',
      data: { object: { object: 'subscription', id: 'sub_zzz', customer: 'cus_zzz', status: 'active', metadata: { workspace_id: '999999' } } },
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.result, 'ignored');
    const { id } = await freshWs();
    const other = await webhook(s.base, { type: 'charge.refunded', data: { object: { object: 'charge', customer: `cus_${id}`, metadata: { workspace_id: String(id) } } } });
    assert.equal(other.body.result, 'ignored');
    const payment = await webhook(s.base, { type: 'checkout.session.completed', data: { object: { mode: 'payment', metadata: { workspace_id: String(id) } } } });
    assert.equal(payment.body.result, 'ignored');
  });

  test('downgraded workspace keeps extra boards but cannot add more', async () => {
    const { owner, slug, id } = await freshWs();
    await webhook(s.base, checkoutCompleted(id));
    assert.equal((await owner('POST', `/api/w/${slug}/boards`, { name: 'Third' })).status, 201);
    assert.equal((await owner('POST', `/api/w/${slug}/boards`, { name: 'Fourth' })).status, 201);
    await webhook(s.base, subscriptionEvent('customer.subscription.deleted', id, { status: 'canceled' }));
    const ws = (await owner('GET', `/api/w/${slug}`)).body;
    assert.equal(ws.boards.length, 4);
    assert.equal(ws.plan.id, 'free');
    assert.equal((await owner('POST', `/api/w/${slug}/boards`, { name: 'Fifth' })).status, 402);
  });
});

describe('stripe.js units', () => {
  test('verifyWebhook accepts any matching v1 signature and enforces tolerance', () => {
    const payload = JSON.stringify({ id: 'evt_u', type: 'x' });
    const t = 1_700_000_000;
    const good = signPayload(payload, SECRET, t);
    const header = `t=${t},v1=${'0'.repeat(64)},v1=${good}`;
    assert.equal(verifyWebhook(payload, header, SECRET, { now: t * 1000 }).id, 'evt_u');
    assert.equal(verifyWebhook(Buffer.from(payload), header, SECRET, { now: (t + 299) * 1000 }).id, 'evt_u');
    assert.throws(() => verifyWebhook(payload, header, SECRET, { now: (t + 301) * 1000 }), /tolerance/);
    assert.throws(() => verifyWebhook(payload, header, SECRET, { now: (t - 301) * 1000 }), /tolerance/);
    assert.throws(() => verifyWebhook(payload, `t=${t},v1=${good}`, 'other', { now: t * 1000 }), /Invalid/);
    assert.throws(() => verifyWebhook(payload, `t=${t}`, SECRET, { now: t * 1000 }), /Missing/);
    assert.throws(() => verifyWebhook(payload, '', SECRET), /Missing/);
    assert.throws(() => verifyWebhook(payload + ' ', `t=${t},v1=${good}`, SECRET, { now: t * 1000 }), /Invalid/);
    assert.throws(() => verifyWebhook(payload, `t=${t},v1=abc`, SECRET, { now: t * 1000 }), /Invalid/);
  });

  test('formEncode handles nested objects and arrays', () => {
    const p = formEncode({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 1 }, { price: 'price_2', quantity: 2 }],
      metadata: { workspace_id: 7, plan: 'pro' },
      skip: undefined,
      none: null,
      flag: true,
    });
    assert.deepEqual([...p.entries()], [
      ['mode', 'subscription'],
      ['line_items[0][price]', 'price_1'],
      ['line_items[0][quantity]', '1'],
      ['line_items[1][price]', 'price_2'],
      ['line_items[1][quantity]', '2'],
      ['metadata[workspace_id]', '7'],
      ['metadata[plan]', 'pro'],
      ['flag', 'true'],
    ]);
  });

  test('createStripeClient sends auth, form body and Idempotency-Key; maps errors', async () => {
    const requests = [];
    const fetchImpl = async (url, opts) => {
      requests.push({ url, opts });
      if (url.endsWith('/v1/billing_portal/sessions')) {
        return new Response(JSON.stringify({ error: { message: 'No such customer' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ id: 'cus_123', url: 'https://x' }), { status: 200 });
    };
    const st = createStripeClient({ secretKey: 'sk_test_abc', fetchImpl, apiBase: 'https://stripe.local' });

    const cus = await st.createCustomer({ email: 'a@b.de', metadata: { workspace_id: 1 } }, 'idem-1');
    assert.equal(cus.id, 'cus_123');
    const r0 = requests[0];
    assert.equal(r0.url, 'https://stripe.local/v1/customers');
    assert.equal(r0.opts.method, 'POST');
    assert.equal(r0.opts.headers.Authorization, 'Bearer sk_test_abc');
    assert.equal(r0.opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(r0.opts.headers['Idempotency-Key'], 'idem-1');
    assert.equal(new URLSearchParams(r0.opts.body).get('metadata[workspace_id]'), '1');
    assert.equal(new URLSearchParams(r0.opts.body).get('email'), 'a@b.de');

    await st.createCheckoutSession({ mode: 'subscription' });
    assert.equal(requests[1].url, 'https://stripe.local/v1/checkout/sessions');
    assert.equal(requests[1].opts.headers['Idempotency-Key'], undefined);

    await assert.rejects(st.createPortalSession({ customer: 'cus_x' }), (e) =>
      e instanceof StripeError && e.status === 400 && /No such customer/.test(e.message));

    const down = createStripeClient({ secretKey: 'k', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    await assert.rejects(down.createCustomer({}), (e) => e instanceof StripeError && e.status === 502);
  });

  test('effectivePlan and withinLimit', () => {
    assert.equal(effectivePlan(null), 'free');
    assert.equal(effectivePlan({ plan: 'pro', plan_status: 'active' }), 'pro');
    assert.equal(effectivePlan({ plan: 'business', plan_status: 'trialing' }), 'business');
    assert.equal(effectivePlan({ plan: 'pro', plan_status: 'past_due' }), 'pro');
    assert.equal(effectivePlan({ plan: 'pro', plan_status: 'incomplete' }), 'free');
    assert.equal(effectivePlan({ plan: 'pro', plan_status: 'canceled' }), 'free');
    assert.equal(effectivePlan({ plan: 'platinum', plan_status: 'active' }), 'free');
    assert.equal(withinLimit(null, 1e9), true);
    assert.equal(withinLimit(2, 1), true);
    assert.equal(withinLimit(2, 2), false);
  });
});
