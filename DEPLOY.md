# Deployment

Pulseboard ist ein einzelner Node-Prozess mit SQLite-Datei. Daraus folgt die wichtigste Regel:

> **Genau eine Instanz pro Datenbank.** Kein horizontales Skalieren, keine zwei Container auf dasselbe Volume. Ein Prozess schafft problemlos Tausende Workspaces; für mehr wäre der Wechsel auf Postgres der nächste Schritt.

| Variante | Geeignet für | Aufwand | Kosten (ca.) |
|---|---|---|---|
| **A: eigener Server mit Docker Compose** (Hetzner, Netcup, …) | volle Kontrolle, DSGVO, günstig | ~20 min | ab 4–6 €/Monat |
| **B: Fly.io** | kein Server-Management | ~10 min | ab ~5 $/Monat |

---

## Checkliste vor dem Livegang

- [ ] Domain mit DNS-Eintrag (A/AAAA) auf den Server bzw. CNAME auf Fly
- [ ] `APP_URL` = öffentliche HTTPS-URL ohne Slash am Ende
- [ ] `APP_SECRET` gesetzt (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
- [ ] Stripe: Produkte + Preise, Webhook, Kundenportal (siehe [README → Abrechnung mit Stripe](README.md#abrechnung-mit-stripe))
- [ ] Resend: Absender-Domain verifiziert (SPF/DKIM), `RESEND_API_KEY`, `MAIL_FROM`
- [ ] Backups aus dem Server heraus kopieren (siehe [Backups](#backups))
- [ ] Impressum und Datenschutzerklärung (für den Betrieb in DE Pflicht, nicht Teil des Codes)

---

## A: Eigener Server mit Docker Compose

Der Stack besteht aus drei Containern:

| Container | Aufgabe |
|---|---|
| `app` | Pulseboard, läuft als Nicht-Root mit schreibgeschütztem Dateisystem, Daten im Volume `pb-data` |
| `caddy` | HTTPS mit automatischem Let's-Encrypt-Zertifikat, HTTP→HTTPS, HSTS, Kompression |
| `backup` | tägliches konsistentes SQLite-Backup nach `/data/backups`, behält 14 Stück |

### 1. Server vorbereiten

Beliebiger Linux-Server mit Docker (z. B. Ubuntu 24.04, 2 GB RAM reichen):

```bash
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443 && ufw enable
```

DNS: `A`-Record `feedback.deinedomain.de` → Server-IP. Caddy braucht Port 80 und 443 frei erreichbar, sonst schlägt die Zertifikatsausstellung fehl.

### 2. Konfigurieren und starten

```bash
git clone <repo-url> pulseboard && cd pulseboard
cp .env.example .env
nano .env        # DOMAIN, APP_URL=https://DOMAIN, APP_SECRET, Stripe, Resend
docker compose up -d --build
docker compose logs -f app caddy
```

`NODE_ENV`, `PORT`, `DB_FILE` und `TRUST_PROXY` setzt `docker-compose.yml` selbst; die Werte aus `.env` werden dafür überschrieben.

### 3. Prüfen

```bash
curl https://feedback.deinedomain.de/api/health     # {"ok":true}
docker compose ps                                   # app: healthy
```

### Updates

```bash
git pull
docker compose up -d --build     # Migrationen laufen beim Start automatisch
```

Vor größeren Updates ein manuelles Backup ziehen (siehe unten). Schema-Migrationen sind vorwärts gerichtet; ein Rollback auf eine ältere Version bedeutet Restore des Backups.

### Alternativ: fertiges Image aus GHCR

Die CI baut bei jedem Push auf `main` und bei Tags `v*` ein Image nach `ghcr.io/<owner>/<repo>`. In `docker-compose.yml` bei `app` und `backup` `build: .` entfernen und `image:` auf das GHCR-Image setzen, dann `docker compose pull && docker compose up -d`.

---

## B: Fly.io

`fly.toml` ist vorbereitet: eine Maschine in Frankfurt, Volume unter `/data`, Healthcheck, HTTPS erzwungen. Die Maschine wird nicht automatisch gestoppt, weil der E-Mail-Versand im selben Prozess läuft.

```bash
fly auth login
fly launch --no-deploy --copy-config --name <app-name>
fly volumes create pb_data --region fra --size 1
fly secrets set \
  APP_URL=https://<app-name>.fly.dev \
  APP_SECRET=<zufällig> \
  STRIPE_SECRET_KEY=sk_live_… STRIPE_WEBHOOK_SECRET=whsec_… \
  STRIPE_PRICE_PRO=price_… STRIPE_PRICE_BUSINESS=price_… \
  RESEND_API_KEY=re_… MAIL_FROM="Pulseboard <noreply@deinedomain.de>"
fly deploy --ha=false        # --ha=false: genau EINE Maschine (SQLite!)
```

Eigene Domain: `fly certs add feedback.deinedomain.de`, danach `APP_URL` per `fly secrets set` anpassen.

Backups auf Fly: Fly erstellt tägliche Volume-Snapshots (5 Tage). Für eigene Backups `fly ssh console -C "node src/backup.js"` und die Datei mit `fly sftp get /data/backups/<datei>` herunterladen.

---

## Stripe-Webhook für Produktion

Im Stripe-Dashboard unter *Entwickler → Webhooks* einen Endpunkt anlegen:

- URL: `https://<deine-domain>/api/stripe/webhook`
- Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
- Das angezeigte Signatur-Secret als `STRIPE_WEBHOOK_SECRET` setzen und die App neu starten

Test- und Live-Modus haben getrennte Schlüssel, Preise und Webhook-Secrets.

---

## Backups

`npm run backup` bzw. der `backup`-Container erzeugt mit `VACUUM INTO` eine konsistente Kopie, auch während die App läuft.

**Wichtig:** Die Backups liegen im selben Volume wie die Datenbank. Gegen Plattenausfall oder Löschen des Servers hilft nur eine Kopie außerhalb, z. B. per Cron auf dem Host:

```bash
# /etc/cron.d/pulseboard-offsite — täglich 03:30 neuestes Backup in einen S3-/Storage-Box-Bucket
30 3 * * * root docker compose -f /root/pulseboard/docker-compose.yml cp \
  backup:/data/backups /var/backups/pulseboard && \
  rclone sync /var/backups/pulseboard remote:pulseboard-backups
```

### Restore

```bash
docker compose stop app
# Datei als App-Nutzer (node) ins Volume schreiben – kein root, Rechte stimmen automatisch
docker compose run --rm -T --no-deps app sh -c \
  'cat > /data/restore.tmp && rm -f /data/pulseboard.db-wal /data/pulseboard.db-shm && mv /data/restore.tmp /data/pulseboard.db' \
  < ./pulseboard-<zeitstempel>.db
docker compose start app
```

Ein Backup aus dem Container holen: `docker compose cp app:/data/backups/<datei> .`

---

## Betrieb

| Thema | Umsetzung |
|---|---|
| Logs | `docker compose logs -f app` bzw. `fly logs` |
| Healthcheck | `GET /api/health` prüft auch die Datenbank; Docker, Caddy und Fly nutzen ihn |
| Uptime-Monitoring | externen Dienst (z. B. Uptime Kuma, Better Stack) auf `/api/health` richten |
| Mail-Fehler | fehlgeschlagene Mails bleiben in `email_outbox` mit `status='failed'` und `last_error` |
| Echte Client-IPs | `TRUST_PROXY=1` (ist in Compose und Fly gesetzt); ohne Proxy auf `0` lassen, sonst sind IPs fälschbar |
| Graceful Shutdown | SIGTERM beendet den Mail-Worker, laufende Requests und schließt die DB sauber (20 s Frist) |
