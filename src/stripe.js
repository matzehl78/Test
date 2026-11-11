// Minimal Stripe client over the REST API (no SDK dependency) and
// webhook signature verification per https://docs.stripe.com/webhooks.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Encode nested objects/arrays in Stripe's bracket form notation. */
export function formEncode(obj) {
  const params = new URLSearchParams();
  const walk = (value, key) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${key}[${i}]`));
    else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}[${k}]` : k);
    } else params.append(key, String(value));
  };
  walk(obj, '');
  return params;
}

export class StripeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function createStripeClient({ secretKey, fetchImpl = fetch, apiBase = 'https://api.stripe.com' }) {
  async function post(path, params, idempotencyKey) {
    const headers = {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res;
    try {
      res = await fetchImpl(`${apiBase}${path}`, { method: 'POST', headers, body: formEncode(params).toString() });
    } catch (e) {
      throw new StripeError(`Stripe unreachable: ${e.message}`, 502);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new StripeError(data?.error?.message || `Stripe error ${res.status}`, res.status);
    return data;
  }

  return {
    createCustomer: (p, key) => post('/v1/customers', p, key),
    createCheckoutSession: (p) => post('/v1/checkout/sessions', p),
    createPortalSession: (p) => post('/v1/billing_portal/sessions', p),
  };
}

export function signPayload(payload, secret, timestamp) {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');
}

/**
 * Verifies a Stripe-Signature header and returns the parsed event.
 * Throws on bad/missing signature or a timestamp outside the tolerance
 * (replay protection).
 */
export function verifyWebhook(payload, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
  let timestamp = null;
  const signatures = [];
  for (const part of String(header || '').split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s?.trim());
    if (k === 't') timestamp = Number(v);
    else if (k === 'v1' && v) signatures.push(v);
  }
  if (!Number.isFinite(timestamp) || !signatures.length) throw new Error('Missing Stripe signature');
  if (Math.abs(now / 1000 - timestamp) > toleranceSec) throw new Error('Stripe signature timestamp outside tolerance');
  const expected = Buffer.from(signPayload(raw, secret, timestamp), 'hex');
  const ok = signatures.some((sig) => {
    const got = Buffer.from(sig, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new Error('Invalid Stripe signature');
  return JSON.parse(raw);
}
