import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createStripeClient } from './stripe.js';
import { createMailer, startOutboxWorker } from './mail.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const PORT = Number(env.PORT) || 3000;
const DB_FILE = env.DB_FILE || join(root, 'data', 'pulseboard.db');
const PROD = env.NODE_ENV === 'production';
const APP_URL = (env.APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

if (PROD && !env.APP_URL) {
  console.error('APP_URL must be set in production (used for email and Stripe redirect links).');
  process.exit(1);
}

const db = openDb(DB_FILE);

const stripe = env.STRIPE_SECRET_KEY ? createStripeClient({ secretKey: env.STRIPE_SECRET_KEY }) : null;
const mailTransport = env.MAIL_TRANSPORT || (env.RESEND_API_KEY ? 'resend' : 'log');
const mailer = createMailer({
  transport: mailTransport,
  from: env.MAIL_FROM || 'Pulseboard <noreply@localhost>',
  apiKey: env.RESEND_API_KEY,
});

const app = createApp({
  db,
  publicDir: join(root, 'public'),
  secureCookies: PROD,
  appUrl: APP_URL,
  secret: env.APP_SECRET,
  stripe,
  billing: {
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    prices: { pro: env.STRIPE_PRICE_PRO, business: env.STRIPE_PRICE_BUSINESS },
  },
});

const stopWorker = startOutboxWorker(db, mailer);
const server = createServer(app);
server.listen(PORT, () => {
  console.log(`Pulseboard läuft auf ${APP_URL}  (DB: ${DB_FILE})`);
  console.log(`  Billing: ${stripe ? 'Stripe aktiv' : 'deaktiviert (STRIPE_SECRET_KEY fehlt)'} · Mail: ${mailTransport}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopWorker();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
