# Pestis on Oracle Cloud

A separate copy of **Pestis** (the Service App, Admin and the Client Portal for pest control field work) that runs on **your own Supabase on an Oracle Cloud server** instead of supabase.co. The original Pestis (`impulsenz/Pesties`) is unchanged.

**To set it up, follow [SETUP.md](SETUP.md).**

| Folder / file | What it is |
|---|---|
| `index.html` | Service App (technicians) |
| `admin.html` | Admin |
| `client.html` | Client Portal (customers) |
| `sw.js` | Offline copy of the apps (service worker) |
| `config.example.js` | Example connection file. The real `config.js` is written on the server and never stored here |
| `sql/install.sql` | The whole database from nothing (tables, security rules, storage, functions). Safe to re-run |
| `sql/parts/` | The same, in the order it's built |
| `setup/` | Server scripts: `install.sh` (everything), `update-app.sh` (pulls new versions), `backup.sh` (nightly), `make-keys.py` |
| `tools/make_oci.py` | Makes these copies from the original apps |
