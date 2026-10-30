# Pestis on Oracle Cloud: step-by-step setup

This sets up a **new, separate copy** of Pestis (Service App, Admin and Client Portal) on **its own Oracle Cloud server**, with the data in an **SQLite database** on that server, the same way as Station Planner. The original Pestis (GitHub Pages + Supabase) isn't touched and keeps working.

It starts with an **empty database**. Sites, staff, client logins and lists are added again in the apps. (The standard pest, preparation and station type lists are there to start with.)

**You'll need:** about 30 minutes, your Oracle Cloud account, and your Google account.

**What you end up with:**

| | Address |
|---|---|
| Service App | `https://<your-address>/` |
| Admin | `https://<your-address>/admin.html` |
| Client Portal | `https://<your-address>/client.html` |

Everything runs on the one server: a small Node.js program with the SQLite database (sign-in, data, photos and documents, live updates), and Caddy for HTTPS. It updates itself from this GitHub repository and backs itself up every night.

---

## 1. Create the server

In the Oracle Cloud console: **☰ → Compute → Instances → Create instance**.

| Setting | Choose |
|---|---|
| Name | `pestis` |
| Image | **Canonical Ubuntu 24.04** (22.04 or Oracle Linux 8/9 also work) |
| Shape | **Ampere → VM.Standard.A1.Flex**: 1 OCPU and 6 GB memory is plenty. Or **VM.Standard.E2.1.Micro** (AMD). Both are *Always Free* |
| Networking | your existing virtual cloud network and **public subnet** are fine; keep **Assign a public IPv4 address** ticked |
| Add SSH keys | **Paste public keys**, and paste the same public key you used for Station Planner (or **Generate a key pair** and download the private key) |

Choose **Create**. When it shows **Running**, copy the **Public IP address**.

- **The free allowance is shared.** Ampere: 4 OCPUs and 24 GB in total across all your Ampere servers. AMD Micro: two servers. If Station Planner uses some, give Pestis what's left.
- **"Out of capacity"?** Try another *Availability domain* (Placement section), the AMD Micro shape, or try again later.

## 2. Open ports 80 and 443

Oracle blocks web traffic until you allow it. If this server is on the **same subnet as Station Planner, this is already done**: skip to step 3.

1. On the instance page, under **Primary VNIC**, open the **Subnet**, then its **Default Security List**.
2. **Add Ingress Rules**, two rules:

   | Source CIDR | IP Protocol | Destination Port Range |
   |---|---|---|
   | `0.0.0.0/0` | TCP | `80` |
   | `0.0.0.0/0` | TCP | `443` |

## 3. Your web address

The server's address is its public IP with dashes and `.sslip.io` on the end. For example, IP `140.238.12.34` gives:

```
https://140-238-12-34.sslip.io
```

(If you own a domain, point an **A record** such as `pestis.yourcompany.co.nz` at the IP and use that instead, with `--domain` in step 5.)

## 4. Google sign-in

You can use the **same Google Cloud project and OAuth client as Station Planner**: just add the new address to it.

1. Go to **console.cloud.google.com**, pick the Station Planner project at the top, then **☰ → APIs & Services → Credentials** (or **Google Auth Platform → Clients**) and open your **Web application** client.
2. **Authorized JavaScript origins → Add URI:** `https://140-238-12-34.sslip.io` (your address, no slash at the end).
3. **Authorized redirect URIs → Add URI:** `https://140-238-12-34.sslip.io/auth/callback`
4. **Save**, and copy the **Client ID** (it ends in `.apps.googleusercontent.com`). You don't need the client secret.

Starting fresh instead? Make a new project, set up the **OAuth consent screen** (External, then **Publish app**), and create a **Web application** client with the two addresses above.

> New addresses can take 5 minutes or so to start working at Google.

## 5. Install Pestis

Connect to the server (PowerShell on Windows, Terminal on Mac):

```
ssh -i path/to/your-private-key ubuntu@140.238.12.34
```

(`opc@` instead of `ubuntu@` on Oracle Linux.) Then paste these two lines, with **your** Client ID and **your** email:

```
curl -fsSL https://raw.githubusercontent.com/impulsenz/pestis-oracle/main/server/setup-pestis-server.sh -o setup.sh
sudo bash setup.sh --google-client-id 1234-abc.apps.googleusercontent.com --admin you@gmail.com
```

It takes 2 to 5 minutes. At the end it prints the three addresses. Several admins can be listed with commas.

## 6. Sign in and set up

1. Open `https://<your-address>/` and **Sign in with Google** with the admin email. You're in as the admin.
2. Open **Admin** (your picture, top right):
   - **Users:** add your technicians' emails so they're approved the moment they first sign in (or approve them after they try).
   - **Client logins:** add each customer's email and tick the sites they can see.
   - **Lists** and **Team settings** as you like them. *Sign out after* (idle time) starts at 5 minutes.
3. Technicians sign in on their phones the same way, and can **Add to Home Screen**.

Clients sign in to the Client Portal with Google. For clients without a Google account, switch on emailed sign-in links (next step).

## 7. Emailed sign-in links for clients (optional)

The Client Portal's **"Email me a sign-in link"** needs an email account to send from. With Gmail:

1. On that Google account, turn on **2-Step Verification**, then go to **Security → App passwords** and make one called `Pestis`.
2. On the server, run the setup again with the email settings added (your other settings are kept):

```
sudo bash setup.sh --smtp-host smtp.gmail.com --smtp-port 587 --smtp-user you@gmail.com --smtp-pass "abcd efgh ijkl mnop" --smtp-from "Pestis <you@gmail.com>"
```

Links only go to emails Pestis knows (client logins, staff, approved emails), work once, and expire after an hour. For lots of email, a sending service such as Brevo or Resend (free plans) is more reliable than Gmail; use their SMTP details the same way.

---

## Day to day

**App updates** happen by themselves: the server checks this GitHub repository every 2 minutes. Then tap the "new version" banner or **Check for updates** in the app. When an update changes the database, the server adds the new tables or columns itself as it restarts. Log: `/var/log/pestis-updates.log`.

**Backups** run every night: the database every night and the photos, floor plans and documents every Sunday, to `/var/backups/pestis` (14 days kept). Copy them off the server now and then, from your computer:

```
scp -i path/to/your-private-key -r ubuntu@140.238.12.34:/var/backups/pestis ./pestis-backups
```

Oracle can also back up the whole disk: **Block Storage → Boot Volumes → your volume → Boot volume backups** (five are free).

**Restore a backup:**

```
sudo systemctl stop pestis
sudo cp /var/backups/pestis/pestis-2026-11-01.db /var/lib/pestis/pestis.db
sudo rm -f /var/lib/pestis/pestis.db-wal /var/lib/pestis/pestis.db-shm
sudo chown pestis:pestis /var/lib/pestis/pestis.db
sudo systemctl start pestis
```

(For files: `sudo tar -xzf /var/backups/pestis/files-<date>.tar.gz -C /var/lib/pestis`.)

| Task | Command |
|---|---|
| See the server's log | `sudo journalctl -u pestis -f` |
| Restart | `sudo systemctl restart pestis` |
| Check it's running | `curl https://<your-address>/api/health` |
| Change settings | `sudo nano /etc/pestis.env`, then `sudo systemctl restart pestis` |
| Keep Ubuntu up to date (monthly) | `sudo apt update && sudo apt upgrade -y` |

Where things are: database `/var/lib/pestis/pestis.db`; photos and documents `/var/lib/pestis/files`; the apps and server `/opt/pestis/app`; settings `/etc/pestis.env`.

**A pretend site to try things on.** This adds a site called "TEST - Harbour Foods (pretend site)" with 14 stations, two critical limits, about 18 months of made-up visits and station checks (with some breaches), recommendations and a pest sighting. It is ordinary data, so all three apps show it like any other site. Nothing else is touched, and `remove` deletes only the test site and everything on it.

| Task | Command (on the server, over SSH) |
|---|---|
| Add the test site | `sudo -u pestis node /opt/pestis/app/tools/test_site.mjs add` |
| ...or a bigger one: 20 stations of every type, 5 years of history | `sudo -u pestis node /opt/pestis/app/tools/test_site.mjs add-big` |
| ...and let a client login see it | `sudo -u pestis node /opt/pestis/app/tools/test_site.mjs add --client someone@example.com` (the client login must already exist in Admin) |
| Is there a test site? | `sudo -u pestis node /opt/pestis/app/tools/test_site.mjs status` |
| Remove it again | `sudo -u pestis node /opt/pestis/app/tools/test_site.mjs remove` |

To start the test site again from scratch, run `remove` and then `add`. It appears in the apps straight away; tap Refresh (or reopen the app) if it's already open.

**A huge pretend site, to push the apps to their limits.** "TEST - Kauri Coast Foods (huge pretend site)": about 3,000 stations of every station type in 6 buildings and 8 floor plans (drawn, every station pinned), 10 years of history (one routine visit most months, up to 5 in a busy month: the initial install, stage installs, call outs, broken treatments, technical support, meetings, fogging, an uninstall), a preparation on every check, about 317,000 station checks, 100 recommendations with notes and photos, 300 pest sightings, 15 contacts, 8 services, 4 critical limits, documents (some expired) and an activity log. It takes about 10 seconds to make and adds about 260 MB to the database.

Heads-up: the apps download a site's whole history when it's opened, so this site takes minutes to open (about 110 MB) and may be too much for a phone. Open it on a computer first. Smaller sizes: add `--stations 500 --years 3`, for example.

| Task | Command (on the server, over SSH) |
|---|---|
| Add the huge site | `sudo -u pestis node /opt/pestis/app/tools/huge_site.mjs add` |
| ...smaller | `sudo -u pestis node /opt/pestis/app/tools/huge_site.mjs add --stations 500 --years 3` |
| ...and let a client login see it | add `--client someone@example.com` (the client login must already exist in Admin) |
| Is it there? | `sudo -u pestis node /opt/pestis/app/tools/huge_site.mjs status` |
| Remove it (and give the space back) | `sudo -u pestis node /opt/pestis/app/tools/huge_site.mjs remove` |

---

## If something goes wrong

| What you see | What to check |
|---|---|
| The address doesn't load at all | Step 2 (ports 80 and 443). Then `sudo systemctl restart caddy` |
| Certificate error with sslip.io | Let's Encrypt sometimes rate-limits shared names. Wait an hour and `sudo systemctl restart caddy`, or use your own domain |
| Google says **redirect_uri_mismatch** | Step 4: the redirect URI must be exactly `https://<your-address>/auth/callback` |
| Google says **origin not allowed** or **invalid_client** | Step 4: origin `https://<your-address>`, no slash at the end; wait 5 minutes after saving |
| "Google sign-in isn't set up on this server yet" | Run step 5 again with `--google-client-id` |
| Signed in but "not approved" | That account isn't an admin or approved yet. Approve it in Admin → Users, or add it with `--admin` |
| Client gets no sign-in email | Step 7; check `sudo journalctl -u pestis -n 50` for "Sign-in email failed" |

---

## How this copy differs from the original

- **Database:** an SQLite file on your own server instead of Supabase. The server (`server/server.mjs`) does what Supabase did: who can see and change what, the automatic numbering (R-0001...), the main site contact, the Client Portal's functions, photo and document storage, and live updates between devices.
- **The apps** are the same as the original Pestis, with `pestis-db.js` in place of the Supabase library. `tools/make_server_copy.py` makes them from the original apps, so later improvements to Pestis are carried across the same way.
- **Version numbers** end in **`-oci`**, for example `2026.10.23-r72-oci`. The offline copy has its own name, so the two Pestis copies never mix.
- **Sign-in** stays on for 30 days of use on a device; the apps still sign out after the idle time set in Admin (5 minutes to start with).
