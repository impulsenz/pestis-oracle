# Pestis (Oracle Cloud copy) - notes for Claude

Pestis is a pest-control field app for a New Zealand pest control business, in three parts that share one server:

| App | File | Who |
|---|---|---|
| Service App | `index.html` | technicians, in the field, mostly on phones (works offline) |
| Admin | `admin.html` (**built**, never edit by hand) | admins |
| Client Portal | `client.html` | the business's customers |

This repo is live: it runs at **https://149-118-72-51.sslip.io** (an Oracle Cloud VM). The server pulls `main` from GitHub every 2 minutes, so **pushing to main deploys**. The old Supabase version (`impulsenz/Pesties`) is retired: don't change it.

The owner is not a programmer. Talk in plain words about what changed for the people using the apps, not about code.

## How each round of changes goes

1. Make the changes (see "Where things are" below).
2. **Bump versions** for each app that changed:
   - Service App: `APP_VERSION` in `index.html` (e.g. `2026.10.29-r73-oci`), and `SHELL_CACHE` / `RUNTIME_CACHE` in `sw.js` (`pestis-oci-shell-v73`, same number as the r-number).
   - Admin: `ADMIN_VERSION` in `tools/build_admin.py` (`...-a18-oci`).
   - Client Portal: `PORTAL_VERSION` in `client.html` (`...-p33-oci`).
   - Dates are the owner's local date (New Zealand). Versions always end in `-oci`.
3. **Add a "What's new" entry** at the top of `LOG` in `src/changelog_shared.js`: `{ rev, date, v: { svc, adm, cli }, svc: [...], adm: [...], cli: [...] }` (only the apps that changed). Plain sentences about what people will notice. `cli` lines are read by customers: never mention staff-only things there.
4. Run **`tools/build.sh`**. It copies the shared What's new and reports code into the apps, rebuilds `admin.html` from `index.html` + `src/admin_src.html`, and syntax-checks every script.
5. Run **`tests/run.sh`** and add tests for anything new (see "Tests"). Look at screenshots at phone width (390px) and desktop (1280px) for anything visual.
6. **Commit and push to `main`** after every round, without asking. End commit messages with the Co-Authored-By line.
7. Tell the owner in a few lines what changed, and what to do: usually just **Check for updates** in the app (or tap the "new version" banner). If `server/` changed, the server restarts by itself within 2 minutes. There is never any SQL to run.

## Where things are

- `index.html`: Service App: one big file (markup, CSS, script). Edit it directly.
- `src/admin_src.html`: Admin's own markup, styles and code. `tools/build_admin.py` combines it with the parts of `index.html` Admin needs (the `WANT` list) into `admin.html`. If Admin needs another function from `index.html`, add its name to `WANT`.
- `client.html`: Client Portal. Edit it directly.
- `src/reports_shared.js` / `.css`: the Reports code shared by Admin and the Client Portal (between `PESTIS-REPORTS` markers).
- `src/changelog_shared.js`: the What's new list shared by all three apps (between `PESTIS-CHANGELOG` markers).
- `pestis-db.js`: stands in for supabase-js. The apps call `_supabase.from(table).select/insert/update/upsert/delete`, `.eq/.neq/.gt/.gte/.lt/.lte/.in/.is/.like/.not/.match/.order/.range/.limit/.single/.maybeSingle`, `.rpc(name, args)`, `.storage.from(bucket)` (upload, createSignedUrl(s), remove), `.channel().on('postgres_changes', ...)` and `.auth`. `.or()` and related tables in `select('x(y)')` are **not** supported: don't use them.
- `server/server.mjs`: the server (Node.js 22.13+, built-in `node:sqlite`, no npm packages):
  - **Access rules:** `readRule()` (who sees which rows) and `canWrite()` (who can add/change/delete). These copy the old Supabase rules.
  - **Automatic behaviour** (the old database triggers): `TRIGGERS`.
  - **Server functions** called with `rpc()`: `RPC`.
  - Sign-in (Google ID token via `/auth/callback`, emailed links), files (`/api/files`, signed links), live updates (`/api/live`, server-sent events).
- `server/schema.mjs`: tables and columns. **To add a column or table, add it here**; the server creates whatever is missing when it starts. A column the apps save that isn't listed is added automatically (logged), but list it properly.
- `server/setup-pestis-server.sh`: the installer (already run on the server; re-running is safe). `SETUP.md` is the owner's guide.
- `tools/make_server_copy.py`: the one-time conversion from the Supabase apps. **Don't run it again**: it would overwrite the apps with the old Supabase versions.

## Rules that must hold

- **Clients never see staff-only information**: the site's notes (safety/access), contract notes, the notes on each service, who started a visit and who the site is assigned to. Clients can't read the `clients` table at all; they get their sites from `RPC.portal_sites`, which removes those fields. Any new staff-only field must be kept out of what clients can read, including live updates (`canRead`).
- A client login sees **only the sites ticked for it** (`client_access`), and only while the login is active.
- Only approved staff change site data. Only admins change lists, documents, critical limits, users and client logins.
- The three apps stay separate (separate pages and sign-in screens), but share one sign-in: the session is stored under `'sb-' + <first part of the host> + '-auth-token'`.
- The apps sign people out after the idle time in Admin → Team settings (default 5 minutes).
- The Service App must keep working offline: records queue on the device and upload later. Never cache `/api/`, `/rest/` or `/auth/` in `sw.js`.

## Tests

`tests/run.sh` (or `tests/run.sh api`, `e2e`, `offline`). Each test starts a real server with a throw-away database, fake Google signing keys (`tests/harness.mjs`, `idToken(email)`) and a fake email server.

- `api.test.mjs`: the real `pestis-db.js` against the server: access rules, automatic behaviour, functions, files, live updates, emailed links.
- `e2e.test.mjs`: the three real apps in Chromium (Playwright): the Service App records a station check and completes a visit, Admin opens, the Client Portal signs in by emailed link, and the Google sign-in round trip. CDN scripts (Tailwind, html5-qrcode, jsPDF) are served from `tests/stubs`, so no internet is needed.
- `offline.test.mjs`: the offline copy.

In the browser tests, sign someone in by putting their session (from `POST /api/auth/google`) in `localStorage` under `sb-127-auth-token` before the page loads. App functions can be called with `page.evaluate` (e.g. `handleScannedBarcode('X')`, `saveStationServiceRecord()`, `flushQueue()`).

## The live server

- Address: https://149-118-72-51.sslip.io (Google OAuth client "pestiesV2" has this origin and `/auth/callback` as a redirect URI).
- Data: `/var/lib/pestis` (`pestis.db`, `files/`). Settings: `/etc/pestis.env`. App: `/opt/pestis/app`. Backups: `/var/backups/pestis`. Log: `sudo journalctl -u pestis -f`.
- Claude can't reach the server directly. If something needs doing on it, give the owner the exact commands to paste over SSH (`ssh -i <key> ubuntu@149.118.72.51`).
