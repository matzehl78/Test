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

## Geschäftsmodell

| | **Free** | **Pro – 19 €/Monat** | **Business – 49 €/Monat** |
|---|---|---|---|
| Workspaces | 1 | 3 | unbegrenzt |
| Boards | 2 | unbegrenzt | unbegrenzt |
| Admins | 1 | 5 | unbegrenzt |
| Posts / Votes | unbegrenzt | unbegrenzt | unbegrenzt |
| Roadmap & Changelog | ✓ | ✓ | ✓ |
| Eigene Farbe / Branding entfernen | – | ✓ | ✓ |
| CSV-Export, Insights | – | ✓ | ✓ |
| Custom Domain, SSO | – | – | ✓ |
| Slack-/Jira-Integration | – | – | ✓ |
| Support | Community | E-Mail | Priorität |

Wachstumshebel: Das öffentliche Board und das Widget tragen „Powered by Pulseboard“ (Free) – jeder Kunde wirbt für das Produkt.

## Schnellstart

Voraussetzung: **Node.js ≥ 22.5** (für `node:sqlite`). Kein `npm install` nötig.

```bash
npm run seed     # Demo-Workspace „Acme Cloud“ mit 15 Posts, Votes, Kommentaren, Changelog
npm start        # http://localhost:3000
npm test         # Test-Suite (node:test)
```

Demo-Login: **demo@pulseboard.dev / demo1234** → http://localhost:3000/acme-cloud

| Variable | Standard | Zweck |
|---|---|---|
| `PORT` | `3000` | HTTP-Port |
| `DB_FILE` | `data/pulseboard.db` | SQLite-Datei |
| `NODE_ENV` | – | `production` setzt `Secure`-Cookies (HTTPS nötig) |

## Architektur

```
src/
  server.js    HTTP-Server, Graceful Shutdown
  app.js       Routen, Rechte, Static-File-Serving (SPA-Fallback)
  http.js      Mini-Router, JSON-Body, Cookies, Validierung
  auth.js      Passwort-Hashing, Sessions, Rate-Limiter
  db.js        SQLite-Schema (node:sqlite), Transaktionen
  similar.js   Duplikaterkennung, Trending-Score
  seed.js      Demo-Daten (idempotent)
public/        Vanilla-JS-SPA + widget.js (kein Build-Schritt)
test/          node:test – API- und Unit-Tests
```

- **Zero Dependencies**: nur Node-Bordmittel (`node:http`, `node:sqlite`, `node:crypto`, `node:test`). Keine Supply-Chain-Risiken, kein Build, Start in Millisekunden.
- **SQLite im WAL-Modus** mit Foreign Keys; Mandantentrennung über `workspace_id` in jeder Abfrage.

### Sicherheit

| Maßnahme | Umsetzung |
|---|---|
| Passwörter | `scrypt` (N=16384, r=8, p=1) mit zufälligem Salt, Vergleich per `timingSafeEqual` |
| Sessions | 256-Bit-Zufallstoken, in der DB nur als SHA-256-Hash gespeichert; serverseitige Invalidierung beim Logout; 30 Tage TTL |
| CSRF | Cookies `HttpOnly; SameSite=Lax` + alle schreibenden Requests erfordern `Content-Type: application/json` (erzwingt CORS-Preflight) |
| CSP & Header | `default-src 'self'`, `frame-ancestors 'none'`, `nosniff`, strikte Referrer-Policy |
| Rate-Limits | Login/Signup 20 pro 15 min, Schreibzugriffe 60/min je Nutzer bzw. IP |
| CSV-Injection | Zellen mit `= + - @` am Anfang werden mit `'` entschärft |
| Eingaben | Längen-/Typprüfung aller Felder, Body-Limit 64 KB, LIKE-Wildcards escaped, Path-Traversal-Schutz |

## API-Übersicht

Alle Bodies sind JSON. 🔓 öffentlich · 👤 Login · 🛡️ Admin · 👑 Owner

| Methode | Pfad | Zugriff | Zweck |
|---|---|---|---|
| POST | `/api/auth/signup` | 🔓 | Konto anlegen `{email, name, password}` |
| POST | `/api/auth/login` | 🔓 | Anmelden `{email, password}` |
| POST | `/api/auth/logout` | 🔓 | Abmelden |
| GET | `/api/me` | 🔓 | Aktueller Nutzer + eigene Workspaces |
| POST | `/api/workspaces` | 👤 | Workspace anlegen `{name, slug?}` |
| GET | `/api/w/:slug` | 🔓 | Workspace, Boards, eigene Rolle |
| PATCH | `/api/w/:slug` | 🛡️ | Name/Akzentfarbe ändern |
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
| GET | `/api/w/:slug/export.csv` | 🛡️ | CSV-Export |
| GET | `/api/health` | 🔓 | Health-Check |

## Widget einbinden

```html
<script src="https://feedback.example.com/widget.js"
        data-workspace="acme-cloud" async></script>
```

Das Skript blendet einen schwebenden „Feedback“-Button ein, der das Board des Workspaces öffnet. `widget.js` wird mit `Access-Control-Allow-Origin: *` ausgeliefert.

## Roadmap

1. **E-Mail-Benachrichtigungen** bei Statuswechsel und Admin-Antwort an alle Voter
2. **SSO** (SAML/OIDC – Okta, Azure AD, Google Workspace)
3. **Stripe-Billing** für Pro/Business inkl. Plan-Limits
4. **Custom Domains** (`feedback.kunde.de`) mit automatischem TLS
5. **Slack-/Jira-Integration** – neue Posts in Kanäle, Jira-Issues verknüpfen und Status synchronisieren
6. **KI-Clustering** – ähnliche Wünsche automatisch gruppieren, Themen-Trends und Zusammenfassungen

## Lizenz

MIT
