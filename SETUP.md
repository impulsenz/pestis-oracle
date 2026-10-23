# Pestis on Oracle Cloud: step-by-step setup

This sets up a **new, separate copy** of Pestis (Service App, Admin and Client Portal) running on **your own Supabase** on an **Oracle Cloud** server. The original Pestis (GitHub Pages + supabase.co) is not touched and keeps working.

It starts with an **empty database**. Sites, staff, client logins and lists are added again in the apps.

**You'll need:** about an hour, a credit or debit card for Oracle's identity check (the server uses the *Always Free* allowance, so it costs nothing), and a Google account.

**What you end up with:**

| | Address |
|---|---|
| Service App | `https://<your-address>/` |
| Admin | `https://<your-address>/admin.html` |
| Client Portal | `https://<your-address>/client.html` |

Everything runs on the one server:
- **Supabase**: the database, Google sign-in, email sign-in links, photo and document storage, and live updates.
- **Caddy**: serves the apps and gets the free https certificate.
- **Nightly backups**, and **automatic app updates** from this GitHub repository every 2 minutes.

---

## 1. Create an Oracle Cloud account

1. Go to **oracle.com/cloud/free** and choose **Start for free**.
2. For **Home Region**, choose **Australia East (Sydney)**, the closest to New Zealand. It can't be changed later.
3. Finish the sign-up, including the card check (nothing is charged on the free tier).

> Already have an account (your Station Planner server is on it)? Use that account. See the note in step 3 about sharing the free allowance.

## 2. Make an SSH key (your key to the server)

An SSH key is a pair of files: a **private** key that stays on your computer, and a **public** key that you give to Oracle.

**Windows** (PowerShell) or **Mac/Linux** (Terminal):

```
ssh-keygen -t ed25519 -f ~/.ssh/pestis_oracle -C "pestis server"
```

Press Enter twice to leave the passphrase empty, or type one for extra safety. This makes two files:
- `~/.ssh/pestis_oracle`: the **private** key. Never share it.
- `~/.ssh/pestis_oracle.pub`: the **public** key. You paste this into Oracle next.

Show the public key so you can copy it:

```
cat ~/.ssh/pestis_oracle.pub
```

On Windows, `~` is `C:\Users\<you>`.

## 3. Create the server (virtual machine)

In the Oracle Cloud console: **☰ → Compute → Instances → Create instance**.

| Setting | Choose |
|---|---|
| Name | `pestis` |
| Image | **Canonical Ubuntu 24.04** (or 22.04) |
| Shape | **Ampere → VM.Standard.A1.Flex**, **4 OCPUs, 24 GB memory** (Always Free) |
| Networking | *Create new virtual cloud network* and *Create new public subnet*, with **Assign a public IPv4 address** ticked |
| Add SSH keys | **Paste public keys**, then paste the whole line from `pestis_oracle.pub` |
| Boot volume | Tick *Specify a custom boot volume size* and enter **100 GB** (free up to 200 GB in total) |

Choose **Create**. When it shows **Running**, copy the **Public IP address**.

- **"Out of capacity"?** The free Ampere servers are popular. Try another *Availability domain* in the Placement section, try 2 OCPUs and 12 GB, or try again later.
- **Station Planner already uses an Ampere server?** The free allowance is 4 OCPUs and 24 GB **in total**. Give this server what's left; 2 OCPUs and 12 GB is plenty for Pestis.

## 4. Open the web ports in Oracle's firewall

On the instance page, open **Primary VNIC → Subnet**. Then open **Security → the security list**, choose **Add Ingress Rules**, and add two rules:

| Source CIDR | IP Protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

Port 22 (SSH) is already open. Don't open any others; the database stays private.

## 5. Get a web address

Google sign-in needs a proper https web address, not a bare IP. You have two options.

**Free (easiest): DuckDNS**
1. Go to **duckdns.org** and sign in, for example with Google.
2. Under *sub domain*, type a name such as `pestis-acme` and choose **add domain**.
3. In **current ip**, paste the server's public IP and choose **update ip**.

Your address is then `pestis-acme.duckdns.org`.

**Your own domain:** in your domain's DNS settings, add an **A record**, for example `pestis.yourcompany.co.nz`, pointing to the server's public IP.

Check that it works: `ping pestis-acme.duckdns.org` should show the server's IP.

## 6. Set up Google sign-in

Go to **console.cloud.google.com**.

1. Use the project picker at the top to make a **New project** called `Pestis`.
2. **☰ → APIs & Services → OAuth consent screen**. This is called *Google Auth Platform* in newer consoles.
   - **Branding:** App name `Pestis`; support email: yours.
   - **Authorized domains:** your address from step 5, for example `pestis-acme.duckdns.org`.
   - **Audience:** **External**. Then choose **Publish app**, so any Google account can sign in, not just test users. Pestis only asks for name and email, so Google doesn't need to review it.
3. **Clients** (or *Credentials → Create credentials → OAuth client ID*):
   - **Application type:** *Web application*. **Name:** `Pestis`.
   - **Authorized JavaScript origins:** `https://pestis-acme.duckdns.org`
   - **Authorized redirect URIs:** `https://pestis-acme.duckdns.org/auth/v1/callback`
   - Choose **Create**, then copy the **Client ID** and **Client secret**.

## 7. Connect to the server

```
ssh -i ~/.ssh/pestis_oracle ubuntu@<server ip>
```

Type `yes` the first time. All the commands from here on are typed on the server.

## 8. Put the apps on the server

The repository is private, so the server gets its own read-only **deploy key**:

```
sudo ssh-keygen -t ed25519 -f /root/.ssh/pestis_deploy -N "" -C "pestis server"
sudo cat /root/.ssh/pestis_deploy.pub
```

On GitHub, open **impulsenz/pestis-oracle → Settings → Deploy keys → Add deploy key**. Give it the title `Oracle server`, paste the line, leave *Allow write access* **unticked**, and choose **Add key**.

Then, on the server:

```
sudo mkdir -p /opt/pestis
sudo GIT_SSH_COMMAND="ssh -i /root/.ssh/pestis_deploy -o StrictHostKeyChecking=accept-new" git clone git@github.com:impulsenz/pestis-oracle.git /opt/pestis/app
```

## 9. Fill in your settings and install

```
sudo cp /opt/pestis/app/setup/pestis.env.example /opt/pestis/pestis.env
sudo nano /opt/pestis/pestis.env
```

Fill in your web address, your email (for the certificate, and to be the first admin), and the Google Client ID and secret from step 6. You can leave the email (SMTP) settings for later. Press **Ctrl+O**, **Enter**, **Ctrl+X** to save.

Then run the installer. It takes about 10 minutes the first time:

```
sudo bash /opt/pestis/app/setup/install.sh
```

At the end it prints your addresses. The keys and passwords it made are in `/opt/pestis/secrets.env`. Keep a copy somewhere safe, such as a password manager:

```
sudo cat /opt/pestis/secrets.env
```

## 10. Sign in

1. Open `https://<your-address>/`. The very first visit can take up to a minute while the certificate is issued.
2. Choose **Sign in with Google** with the email you put in `ADMIN_EMAIL`. You're the admin.
3. Open **Admin** (your menu, top right) to approve technicians, add client logins, and set up the lists, critical limits and so on.

Technicians: when they first sign in, approve them in **Admin → Users**, or add their emails there beforehand so they're approved straight away.

## 11. Email sign-in links for clients (optional)

The Client Portal's **"Email me a sign-in link"** needs an email account to send from. Clients can sign in with Google without it. With Gmail:

1. On your Google account, turn on **2-Step Verification**. Then go to **Security → App passwords** and make one called `Pestis`.
2. On the server, edit `sudo nano /opt/pestis/pestis.env` and set:
   - `SMTP_HOST="smtp.gmail.com"`
   - `SMTP_PORT="587"`
   - `SMTP_USER` and `SMTP_ADMIN_EMAIL`: your Gmail address
   - `SMTP_PASS`: the app password, without spaces
3. Run `sudo bash /opt/pestis/app/setup/install.sh` again.

For lots of emails, a sending service such as Brevo or Resend (both have free plans) is more reliable than Gmail; use their SMTP details the same way.

---

## Day to day

**App updates.** When Claude pushes a new version to this repository, the server picks it up within 2 minutes. Then use **Check for updates** in the app, or tap the "new version" banner. There's a log of updates in `/var/log/pestis-updates.log`.

**Database changes.** When an update changes the database (`sql/` changes), run the installer again: `sudo bash /opt/pestis/app/setup/install.sh`. It's safe to re-run and only adds what's new.

**Backups.**
- **When:** the database every night at 2:30am, and the stored files (photos, plans, documents) every Sunday.
- **Where:** `/opt/pestis/backups`, kept for 14 days.
- **Off the server:** now and then, from your computer:
  ```
  scp -i ~/.ssh/pestis_oracle -r ubuntu@<server ip>:/opt/pestis/backups ./pestis-backups
  ```
- **Optional:** Oracle can also snapshot the whole disk under **Block Storage → Boot Volumes → your volume → Boot volume backups**. Five backups are free.

**Supabase's dashboard (Studio).** This has the table editor, SQL editor and so on. It isn't on the internet; reach it through an SSH tunnel:

```
ssh -i ~/.ssh/pestis_oracle -L 8000:127.0.0.1:8000 ubuntu@<server ip>
```

Then open **http://localhost:8000** on your computer. The user is `pestis` and the password is `DASHBOARD_PASSWORD` in `/opt/pestis/secrets.env`.

**Keeping the server up to date**, about once a month:

```
sudo apt update && sudo apt upgrade -y
cd /opt/supabase && sudo docker compose pull && sudo docker compose up -d
```

**Restart everything:** `sudo reboot`. Supabase and the web server start again on their own.

---

## If something goes wrong

| What you see | What to check |
|---|---|
| The address doesn't load at all | Step 4 rules for ports 80 and 443; step 5 address points to the right IP; `sudo systemctl status caddy` |
| Certificate or "not secure" error | Same as above. The address must point to the server *before* the installer runs. Then `sudo systemctl restart caddy` |
| Google says **redirect_uri_mismatch** | Step 6 redirect URI must be exactly `https://<your-address>/auth/v1/callback` |
| Google says access blocked / app not verified | Step 6: **Publish app** (Audience) |
| Signed in but "not approved" | You signed in with a different email from `ADMIN_EMAIL`. Approve that account in Admin, or fix `ADMIN_EMAIL` and run the installer again |
| Red bar: "config.js is missing" | Run the installer again (it writes `/opt/pestis/app/config.js`) |
| Installer stopped while Supabase was starting | `cd /opt/supabase && sudo docker compose ps`, then `sudo docker compose logs --tail 50 auth db storage` |

**Logs:**
- Apps and web server: `sudo journalctl -u caddy --since "1 hour ago"`
- Supabase: `cd /opt/supabase && sudo docker compose logs --tail 100 <service>`, where the services are `auth`, `rest`, `storage`, `realtime`, `db` and `kong`.

---

## How this copy differs from the original

- **Database:** your own Supabase at the same address as the apps, instead of supabase.co. The apps read the address and public key from `config.js`, which the installer writes on the server and is never stored in GitHub.
- **Version numbers:** these copies end in **`-oci`**, for example `2026.10.23-r72-oci`. The offline cache has its own name, so the two Pestis copies never mix.
- **Starting empty:** the database begins empty. `sql/install.sql` builds every table, security rule, storage bucket and function from nothing. `sql/parts/` has the same thing in pieces.
- **Keeping in step:** `tools/make_oci.py` makes these copies from the original apps, so later improvements to Pestis can be carried across the same way.
