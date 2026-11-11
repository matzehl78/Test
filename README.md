# Pulseboard

**Feedback, Roadmap & Changelog für SaaS-Teams – in einer App, ohne eine einzige Laufzeit-Abhängigkeit.**

## Pitch

| | |
|---|---|
| **Problem** | Feature-Wünsche landen verstreut in Support-Tickets, E-Mails, Slack und Calls. Produktteams priorisieren nach Bauchgefühl, Kunden erfahren nie, ob ihr Wunsch umgesetzt wurde – Duplikate und Frust inklusive. |
| **Lösung** | Ein öffentliches Feedback-Board pro Produkt: Kunden posten und voten, Duplikate werden beim Schreiben erkannt, das Team pflegt Status und Roadmap, und ein Changelog-Eintrag schließt den Kreis automatisch (verknüpfte Wünsche → „Erledigt“). |
| **Zielgruppe** | B2B-SaaS-Startups und KMU-Softwarehäuser (5–200 MA), Product Manager, Customer-Success-Teams. Günstige, selbst hostbare Alternative zu Canny, Featurebase & Co. |

## Features

- **Workspaces** mit eigener URL (`/acme-cloud`), Akzentfarbe, mehreren Boards (Standard: *Feature Requests*, *Bugs*)
- **Posts & Votes** – Autor stimmt automatisch mit, Vote-Toggle, Kommentare (Admin-Antworten hervorgehoben)
- **Sortierung** nach Top, Neu und *Trending* (zeitlich gewichtete Votes)
- **Duplikaterkennung** beim Tippen (Token-Ähnlichkeit, DE/EN-Stoppwörter)
- **Status-Workflow**: Offen → In Prüfung → Geplant → In Arbeit → Erledigt / Geschlossen, mit Verlauf
- **Öffentliche Roadmap** (Geplant / In Arbeit / Erledigt)
- **Changelog** – verknüpfte Posts werden automatisch auf „Erledigt“ gesetzt
- **Insights** für Admins: Kennzahlen, Status-Verteilung, 30-Tage-Aktivität, unbearbeitete Top-Wünsche
- **CSV-Export** aller Posts
- **Team**: Owner kann weitere Admins hinzufügen
- **Embed-Widget** für die eigene Website
- **E-Mail-Benachrichtigungen** an Autor, Voter und Kommentierende bei Statuswechsel, Team-Antwort und Release – mit One-Click-Abmeldung
- **Abrechnung mit Stripe**: Checkout, Kundenportal, Plan-Limits pro Workspace, Kulanzzeit bei Zahlungsproblemen

## Geschäftsmodell

Abgerechnet wird **pro Workspace** (ein Workspace = ein Produkt-Board) über Stripe-Abos.

| | **Free** | **Pro – 19 €/Monat** | **Business – 49 €/Monat** |
|---|---|---|---|
| Kostenlose Workspaces je Owner | 1 | weitere möglich¹ | weitere möglich¹ |
| Boards | 2 | 10 | unbegrenzt |
| Admins (inkl. Owner) | 1 | 3 | unbegrenzt |
| Posts / Votes / Kommentare | unbegrenzt | unbegrenzt | unbegrenzt |
| Roadmap, Changelog, Insights, E-Mail-Benachrichtigungen | ✓ | ✓ | ✓ |
| Eigene Akzentfarbe | – | ✓ | ✓ |
| CSV-Export | – | ✓ | ✓ |
| Support | Community | E-Mail | Priorität |
| SSO, Custom Domain | – | – | geplant |

¹ Wer einen bezahlten Workspace besitzt, darf zusätzlich einen weiteren kostenlosen anlegen; die Grenze „1 Free-Workspace pro Owner“ zählt nur Workspaces im Free-Plan.

Die Limits sind serverseitig in `src/plans.js` definiert; Überschreitungen beantwortet die API mit **`402 Payment Required`** und `{"error": "…", "details": {"feature": "boards", "upgrade": true}}`, das Frontend zeigt daraufhin einen Upgrade-Hinweis. Bei einem Downgrade bleiben bestehende Daten (z. B. ein drittes Board) erhalten, es können nur keine weiteren angelegt werden.

## Schnellstart

Voraussetzung: **Node.js ≥ 22.5** (für `node:sqlite`). Kein `npm install` nötig.

```bash
npm run seed     # Demo-Workspace „Acme Cloud“ mit 15 Posts, Votes, Kommentaren, Changelog
npm start        # http://localhost:3000
npm test         # Test-Suite (node:test)
```

Demo-Login: **demo@pulseboard.dev / demo1234** → http://localhost:3000/acme-cloud

Der Demo-Workspace läuft im **Business**-Plan, damit alle Funktionen sichtbar sind. Demo-Nutzer erhalten keine E-Mails.

| Variable | Standard | Zweck |
|---|---|---|
| `PORT` | `3000` | HTTP-Port |
| `DB_FILE` | `data/pulseboard.db` | SQLite-Datei |
| `NODE_ENV` | – | `production` setzt `Secure`-Cookies (HTTPS nötig) und erzwingt `APP_URL` |
| `APP_URL` | `http://localhost:$PORT` | Öffentliche Basis-URL für Links in E-Mails und Stripe-Redirects |
| `APP_SECRET` | wird generiert und in der DB gespeichert | Signiert Abmelde-Links in E-Mails |
| `STRIPE_*`, `MAIL_*`, `RESEND_API_KEY` | – | siehe [Abrechnung](#abrechnung-mit-stripe) und [E-Mail](#e-mail-benachrichtigungen) |

Alle Variablen mit Kommentaren stehen in [`.env.example`](.env.example). Node lädt sie z. B. mit `node --env-file=.env src/server.js`.

## Abrechnung mit Stripe

Stripe wird direkt über die REST-API angesprochen (kein SDK). Ohne `STRIPE_SECRET_KEY` läuft die App vollständig im Free-Modus; die Billing-Endpunkte antworten dann mit `503`.

**Einrichtung**

1. Im Stripe-Dashboard zwei **Produkte** mit je einem monatlich wiederkehrenden **Preis** anlegen (Pro 19 €, Business 49 €) und die Preis-IDs (`price_…`) notieren.
2. Unter *Einstellungen → Billing → Kundenportal* das **Customer Portal aktivieren** (Zahlungsmethode ändern, kündigen, Planwechsel zwischen den beiden Preisen erlauben). Ohne aktiviertes Portal schlägt „Abo verwalten“ fehl.
3. Einen **Webhook-Endpunkt** `https://<APP_URL>/api/stripe/webhook` anlegen mit diesen Events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
4. Umgebungsvariablen setzen:

| Variable | Zweck |
|---|---|
| `STRIPE_SECRET_KEY` | API-Schlüssel (`sk_live_…` / `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | Signatur-Secret des Webhook-Endpunkts (`whsec_…`) |
| `STRIPE_PRICE_PRO` | Preis-ID für Pro |
| `STRIPE_PRICE_BUSINESS` | Preis-ID für Business |
| `APP_URL` | Basis-URL für `success_url`, `cancel_url` und Portal-Rücksprung |

**Lokal testen** mit der Stripe-CLI:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
# gibt ein whsec_… aus → als STRIPE_WEBHOOK_SECRET setzen
stripe trigger checkout.session.completed
```

**Ablauf**: Der Owner wählt im Admin-Bereich einen Plan → `POST /billing/checkout` legt (einmalig, mit Idempotency-Key) einen Stripe-Kunden an und leitet zur gehosteten Checkout-Seite weiter → Stripe meldet den Abschluss per Webhook → der Workspace wird hochgestuft. Planwechsel, Kündigung und Zahlungsdaten laufen über das Stripe-Kundenportal.

**Regeln für Berechtigungen**

| Abo-Status (Stripe) | Wirkung |
|---|---|
| `active`, `trialing` | Bezahlter Plan aktiv |
| `past_due` | **Kulanzzeit**: Plan bleibt aktiv, während Stripe die Zahlung erneut versucht; der Owner erhält eine E-Mail „Zahlung fehlgeschlagen“ |
| `incomplete` | noch kein Zugriff (Erstzahlung offen) |
| `unpaid`, `canceled`, `incomplete_expired`, gelöschtes Abo | zurück auf Free |

**Robustheit**: Webhook-Signaturen werden per HMAC-SHA256 mit konstantem Vergleich und 5 Minuten Zeittoleranz (Replay-Schutz) geprüft. Jedes Event wird anhand seiner ID genau einmal verarbeitet (Stripe liefert „at least once“), in derselben Transaktion wie die Planänderung. Events für ein bereits ersetztes Abo werden ignoriert.

## E-Mail-Benachrichtigungen

Pulseboard schließt den Feedback-Kreis per E-Mail an alle, die einer Idee folgen (Autor, Voter, Kommentierende – jeweils ohne die auslösende Person):

| Ereignis | E-Mail |
|---|---|
| Statuswechsel einer Idee (außer zurück auf „Offen“) | „Geplant: <Titel>“ mit altem → neuem Status |
| Kommentar eines Admins | „Antwort des Teams: <Titel>“ mit dem Kommentar |
| Changelog-Eintrag mit verknüpften Ideen | **eine** Sammel-Mail pro Person („Ausgeliefert: …“), keine zusätzlichen Status-Mails |
| `invoice.payment_failed` | an den Owner (transaktional, auch bei abgeschalteten Benachrichtigungen) |

**Zustellung über eine Outbox**: E-Mails werden in derselben Datenbank-Transaktion wie die auslösende Änderung in `email_outbox` geschrieben. Ein Worker (alle 5 s) versendet sie; bei Fehlern wird mit exponentiellem Backoff (1, 2, 4, 8, 16 min) bis zu 6-mal wiederholt. Dauerhafte Fehler (4xx außer 429) markieren die Mail sofort als `failed`. So geht keine Benachrichtigung verloren, wenn der Mail-Dienst kurz nicht erreichbar ist.

| Variable | Standard | Zweck |
|---|---|---|
| `MAIL_TRANSPORT` | `log`, bzw. `resend` wenn `RESEND_API_KEY` gesetzt | `log` gibt Mails nur auf der Konsole aus (Entwicklung), `resend` versendet über die [Resend](https://resend.com)-HTTP-API |
| `RESEND_API_KEY` | – | API-Schlüssel für Resend |
| `MAIL_FROM` | `Pulseboard <noreply@localhost>` | Absender – die Domain muss bei Resend **verifiziert** sein (SPF/DKIM) |
| `APP_SECRET` | generiert, in der DB gespeichert | HMAC-Schlüssel für Abmelde-Links; in Produktion fest setzen |

**Abmelden**: Jede Mail enthält einen signierten Abmelde-Link sowie die Header `List-Unsubscribe` und `List-Unsubscribe-Post` für **One-Click-Unsubscribe nach RFC 8058** (Gmail/Yahoo-Pflicht für Massenversender). `GET /api/unsubscribe` zeigt nur eine Bestätigungsseite (Mail-Scanner rufen Links vorab auf), erst `POST` meldet ab. Nutzer können Benachrichtigungen auch über `PATCH /api/me {"emailNotifications": false}` steuern.

## Architektur

```
src/
  server.js    HTTP-Server, Graceful Shutdown
  app.js       Routen, Rechte, Static-File-Serving (SPA-Fallback)
  http.js      Mini-Router, JSON-Body, Cookies, Validierung
  auth.js      Passwort-Hashing, Sessions, Rate-Limiter
  db.js        SQLite-Schema (node:sqlite), versionierte Migrationen, Transaktionen
  similar.js   Duplikaterkennung, Trending-Score
  plans.js     Pläne, Limits, Berechtigungen nach Abo-Status
  stripe.js    Stripe-REST-Client, Webhook-Signaturprüfung
  mail.js      Outbox, Versand (log/Resend), Retries, Abmelde-Token
  notify.js    Benachrichtigungs-Mails (Status, Antworten, Changelog, Zahlung)
  seed.js      Demo-Daten (idempotent)
public/        Vanilla-JS-SPA + widget.js (kein Build-Schritt)
test/          node:test – API- und Unit-Tests
```

- **Zero Dependencies**: nur Node-Bordmittel (`node:http`, `node:sqlite`, `node:crypto`, `node:test`). Keine Supply-Chain-Risiken, kein Build, Start in Millisekunden.
- **SQLite im WAL-Modus** mit Foreign Keys; Mandantentrennung über `workspace_id` in jeder Abfrage.
- **Migrationen** über `PRAGMA user_version`: bestehende Datenbanken werden beim Start automatisch aktualisiert (nur anhängen, nie bestehende Migrationen ändern).

### Sicherheit

| Maßnahme | Umsetzung |
|---|---|
| Passwörter | `scrypt` (N=16384, r=8, p=1) mit zufälligem Salt, Vergleich per `timingSafeEqual` |
| Sessions | 256-Bit-Zufallstoken, in der DB nur als SHA-256-Hash gespeichert; serverseitige Invalidierung beim Logout; 30 Tage TTL |
| CSRF | Cookies `HttpOnly; SameSite=Lax` + alle schreibenden Requests erfordern `Content-Type: application/json` (erzwingt CORS-Preflight). Ausnahmen nur für Endpunkte ohne Cookie-Auth: Stripe-Webhook (Signatur) und Abmelde-Link (HMAC-Token) |
| Stripe-Webhooks | HMAC-SHA256-Signatur, 5 min Zeittoleranz, Event-Deduplizierung |
| E-Mails | Nutzerinhalte werden HTML-escaped; Abmelde-Links per HMAC signiert; Links nutzen ausschließlich `APP_URL` (kein Host-Header) |
| CSP & Header | `default-src 'self'`, `frame-ancestors 'none'`, `nosniff`, strikte Referrer-Policy |
| Rate-Limits | Login/Signup 20 pro 15 min, Schreibzugriffe 60/min je Nutzer bzw. IP |
| CSV-Injection | Zellen mit `= + - @` am Anfang werden mit `'` entschärft |
| Eingaben | Längen-/Typprüfung aller Felder, Body-Limit 64 KB, LIKE-Wildcards escaped, Path-Traversal-Schutz |

## API-Übersicht

Alle Bodies sind JSON. `402` = Funktion im aktuellen Plan nicht enthalten. 🔓 öffentlich · 👤 Login · 🛡️ Admin · 👑 Owner

| Methode | Pfad | Zugriff | Zweck |
|---|---|---|---|
| POST | `/api/auth/signup` | 🔓 | Konto anlegen `{email, name, password}` |
| POST | `/api/auth/login` | 🔓 | Anmelden `{email, password}` |
| POST | `/api/auth/logout` | 🔓 | Abmelden |
| GET | `/api/me` | 🔓 | Aktueller Nutzer (inkl. `emailNotifications`) + eigene Workspaces |
| PATCH | `/api/me` | 👤 | Profil `{name?, emailNotifications?}` |
| GET / POST | `/api/unsubscribe?u&t` | 🔓 (signierter Link) | Bestätigungsseite / Abmelden (RFC 8058) |
| POST | `/api/workspaces` | 👤 | Workspace anlegen `{name, slug?}` |
| GET | `/api/w/:slug` | 🔓 | Workspace, Boards, eigene Rolle (Admins zusätzlich `plan`) |
| PATCH | `/api/w/:slug` | 🛡️ | Name ändern; Akzentfarbe ab Pro |
| GET / POST | `/api/w/:slug/members` | 🛡️ / 👑 | Team anzeigen / Admin hinzufügen `{email}` |
| POST | `/api/w/:slug/boards` | 🛡️ | Board anlegen `{name}` |
| GET | `/api/w/:slug/posts?board&status&sort=top\|new\|trending&q&limit` | 🔓 | Posts listen |
| GET | `/api/w/:slug/similar?q=` | 🔓 | Ähnliche Posts (Duplikate) |
| POST | `/api/w/:slug/posts` | 👤 | Post anlegen `{boardId, title, body?}` |
| GET | `/api/w/:slug/posts/:id` | 🔓 | Post mit Kommentaren und Statusverlauf |
| PATCH | `/api/w/:slug/posts/:id` | 👤 Autor / 🛡️ | Titel/Text (Autor), Status/Board (Admin) |
| DELETE | `/api/w/:slug/posts/:id` | 👤 Autor / 🛡️ | Post löschen |
| POST | `/api/w/:slug/posts/:id/vote` | 👤 | Vote umschalten |
| POST | `/api/w/:slug/posts/:id/comments` | 👤 | Kommentar `{body}` |
| GET | `/api/w/:slug/roadmap` | 🔓 | Spalten Geplant / In Arbeit / Erledigt |
| GET | `/api/w/:slug/changelog` | 🔓 | Changelog-Einträge |
| POST | `/api/w/:slug/changelog` | 🛡️ | Eintrag `{title, body?, postIds?, markDone?=true}` |
| GET | `/api/w/:slug/stats` | 🛡️ | Insights |
| GET | `/api/w/:slug/export.csv` | 🛡️ | CSV-Export (ab Pro) |
| GET | `/api/w/:slug/billing` | 🛡️ | Plan, Status, Laufzeitende, geplante Kündigung (`cancelAtPeriodEnd`), Nutzung, Planübersicht |
| POST | `/api/w/:slug/billing/checkout` | 👑 | Stripe-Checkout starten `{plan: "pro"\|"business"}` → `{url}` |
| POST | `/api/w/:slug/billing/portal` | 👑 | Stripe-Kundenportal öffnen → `{url}` |
| POST | `/api/stripe/webhook` | Stripe-Signatur | Abo-Ereignisse von Stripe |
| GET | `/api/health` | 🔓 | Health-Check |

## Widget einbinden

```html
<script src="https://feedback.example.com/widget.js"
        data-workspace="acme-cloud" async></script>
```

Das Skript blendet einen schwebenden „Feedback“-Button ein, der das Board des Workspaces öffnet. `widget.js` wird mit `Access-Control-Allow-Origin: *` ausgeliefert.

## Roadmap

1. **SSO** (SAML/OIDC – Okta, Azure AD, Google Workspace) für Business
2. **Custom Domains** (`feedback.kunde.de`) mit automatischem TLS
3. **Slack-/Jira-Integration** – neue Posts in Kanäle, Jira-Issues verknüpfen und Status synchronisieren
4. **Jahresabos & Testphase** (Stripe-Trial, Rabatt bei jährlicher Zahlung), wöchentlicher Digest statt Einzel-Mails
5. **KI-Clustering** – ähnliche Wünsche automatisch gruppieren, Themen-Trends und Zusammenfassungen

## Lizenz

MIT
