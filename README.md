# Pestis on Oracle Cloud

A separate copy of **Pestis** (the Service App, Admin and the Client Portal for pest control field work) that runs on **your own Oracle Cloud server with an SQLite database**, like Station Planner. The original Pestis (`impulsenz/Pesties`, on Supabase) is unchanged.

**To set it up, follow [SETUP.md](SETUP.md).** It's one command on a new server.

```
browser ──HTTPS──► Caddy (certificates) ──► Pestis server (Node.js, 127.0.0.1:8080) ──► SQLite + files
```

| Folder / file | What it is |
|---|---|
| `index.html` | Service App (technicians) |
| `admin.html` | Admin |
| `client.html` | Client Portal (customers) |
| `pestis-db.js` | The apps' connection to the Pestis server (in place of the Supabase library) |
| `sw.js` | Offline copy of the apps (service worker) |
| `server/server.mjs` | The server: database, sign-in, photos and documents, live updates. Node.js 22.13+, no npm packages |
| `server/schema.mjs` | The tables and columns. Missing ones are added when the server starts |
| `server/mail.mjs` | Sends the Client Portal's emailed sign-in links |
| `server/callback.html` | Finishes signing in after Google (or an emailed link) |
| `server/setup-pestis-server.sh` | Installs or updates everything on an Oracle Cloud server |
| `tools/make_server_copy.py` | Makes these app copies from the original Pestis apps |

## What the server does

- **Sign-in:** Google (checked against Google's keys), or a one-time emailed link for client logins. The admins in `ADMIN_EMAILS` are always approved; everyone else is approved in Admin.
- **Who sees what:** approved staff see every site; a client login sees only its own sites, and never staff notes; only admins change lists, documents, users and client logins. These are the same rules the Supabase version had.
- **Automatic bits:** recommendation numbers, recommendation status from its updates, one main contact per site (copied to the site's contact), standard document folders for new sites, and removing a floor plan unpins its stations.
- **Files:** photos, floor plans and documents are stored on the server and opened through short-lived signed links.
- **Live updates:** changes appear on other devices straight away (server-sent events).

## Settings (`/etc/pestis.env`)

| Setting | What it does |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth "Web application" client ID |
| `ADMIN_EMAILS` | Comma-separated emails that are always approved admins |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Optional: emailed sign-in links for clients |
| `SESSION_DAYS` | How long a sign-in lasts on a device without being used (default 30). The apps also sign out after the idle time set in Admin |
