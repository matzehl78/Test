// Plan catalogue and entitlement checks. `null` = unlimited.

export const PLANS = {
  free: {
    name: 'Free',
    priceEur: 0,
    limits: { ownedWorkspaces: 1, boards: 2, admins: 1 },
    features: { branding: false, csvExport: false },
  },
  pro: {
    name: 'Pro',
    priceEur: 19,
    limits: { ownedWorkspaces: null, boards: 10, admins: 3 },
    features: { branding: true, csvExport: true },
  },
  business: {
    name: 'Business',
    priceEur: 49,
    limits: { ownedWorkspaces: null, boards: null, admins: null },
    features: { branding: true, csvExport: true },
  },
};

export const PAID_PLANS = ['pro', 'business'];

// Stripe statuses that keep paid entitlements. past_due = grace period while
// Stripe retries the card (Smart Retries); afterwards it becomes unpaid/canceled.
const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function effectivePlan(ws) {
  if (!ws || !PLANS[ws.plan] || ws.plan === 'free') return 'free';
  return ENTITLED_STATUSES.has(ws.plan_status) ? ws.plan : 'free';
}

export function planInfo(ws) {
  const id = effectivePlan(ws);
  return { id, ...PLANS[id] };
}

export function withinLimit(limit, used) {
  return limit === null || used < limit;
}
