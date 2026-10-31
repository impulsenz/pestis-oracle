#!/usr/bin/env bash
# =====================================================================
#  Pestis server setup for an Oracle Cloud (OCI) compute VM
#  Works on Canonical Ubuntu 22.04/24.04 and Oracle Linux 8/9 (x86 or Ampere Arm).
#
#  Usage:   sudo bash setup-pestis-server.sh [options]
#    --google-client-id ID     Google sign-in (OAuth "Web application" client ID)
#    --admin you@gmail.com     admin account(s), comma-separated: always approved, can approve everyone else
#    --domain pestis.example.com   use your own domain instead of <ip>.sslip.io
#    --smtp-host smtp.gmail.com --smtp-port 587 --smtp-user you@gmail.com --smtp-pass APPPASSWORD [--smtp-from "Pestis <you@gmail.com>"]
#                              optional: lets clients get an emailed sign-in link (Client Portal)
#  Settings are kept in /etc/pestis.env, so re-running without options keeps them.
#  Re-run it any time; it's safe.
#
#  What it does:
#    - installs Node.js 24, SQLite, git and the Caddy web server
#    - puts the apps and the server in /opt/pestis/app (from GitHub: impulsenz/pestis-oracle)
#    - keeps the database and the photos/documents in /var/lib/pestis
#    - gets a free HTTPS certificate (uses <your-ip>.sslip.io if no domain is given)
#    - opens ports 80 and 443 in the VM's own firewall
#    - checks GitHub for a newer version every 2 minutes and updates itself
#    - backs up every night to /var/backups/pestis (14 days kept)
# =====================================================================
set -euo pipefail

DOMAIN=""; CLIENT_ID=""; ADMINS=""
SMTP_HOST=""; SMTP_PORT=""; SMTP_USER=""; SMTP_PASS=""; SMTP_FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --google-client-id) CLIENT_ID="${2:-}"; shift 2;;
    --admin|--admins) ADMINS="${2:-}"; shift 2;;
    --domain) DOMAIN="${2:-}"; shift 2;;
    --smtp-host) SMTP_HOST="${2:-}"; shift 2;;
    --smtp-port) SMTP_PORT="${2:-}"; shift 2;;
    --smtp-user) SMTP_USER="${2:-}"; shift 2;;
    --smtp-pass) SMTP_PASS="${2:-}"; shift 2;;
    --smtp-from) SMTP_FROM="${2:-}"; shift 2;;
    -*) echo "Unknown option $1"; exit 1;;
    *) DOMAIN="$1"; shift;;
  esac
done
REPO=https://github.com/impulsenz/pestis-oracle.git
ENV_FILE=/etc/pestis.env
APP_DIR=/opt/pestis/app
DATA_DIR=/var/lib/pestis
BACKUP_DIR=/var/backups/pestis
PORT=8080

say(){ printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die(){ printf '\n\033[1;31mERROR: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo:  sudo bash $0"
if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
else die "This script supports Ubuntu (apt) and Oracle Linux (dnf) only."; fi

node_ok(){ command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }

install_caddy_binary(){
  say "Installing Caddy from caddyserver.com"
  local arch; case "$(uname -m)" in aarch64|arm64) arch=arm64;; *) arch=amd64;; esac
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${arch}" -o /usr/bin/caddy
  chmod +x /usr/bin/caddy
  id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --create-home --shell "$(command -v nologin)" caddy
  mkdir -p /etc/caddy
  cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy web server
After=network-online.target
Wants=network-online.target
[Service]
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
}

say "Installing packages (this takes a few minutes the first time)"
if [ "$PM" = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg git sqlite3 cron debian-keyring debian-archive-keyring apt-transport-https
  if ! node_ok; then curl -fsSL https://deb.nodesource.com/setup_24.x | bash -; apt-get install -y nodejs; fi
  if ! command -v caddy >/dev/null 2>&1; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y && apt-get install -y caddy || install_caddy_binary
  fi
else
  dnf install -y curl git sqlite cronie
  systemctl enable --now crond || true
  if ! node_ok; then curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -; dnf install -y nodejs; fi
  if ! command -v caddy >/dev/null 2>&1; then
    { dnf install -y 'dnf-command(copr)' && dnf copr enable -y @caddy/caddy && dnf install -y caddy; } || install_caddy_binary
  fi
fi
node_ok || die "Node.js 22.13 or newer is needed but could not be installed."
NODE_BIN="$(command -v node)"
echo "Node $(node -v), Caddy $(caddy version | head -1)"

say "Settings"
touch "$ENV_FILE"; chmod 640 "$ENV_FILE"
setenv(){ local k="$1" v="$2" e; e="${v//\\/\\\\}"; e="${e//|/\\|}"; e="${e//&/\\&}"; if grep -q "^$k=" "$ENV_FILE"; then sed -i "s|^$k=.*|$k=$e|" "$ENV_FILE"; else printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"; fi; }
getenv(){ grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
[ -n "$CLIENT_ID" ] && setenv GOOGLE_CLIENT_ID "$CLIENT_ID"
[ -n "$ADMINS" ] && setenv ADMIN_EMAILS "$ADMINS"
[ -n "$SMTP_HOST" ] && setenv SMTP_HOST "$SMTP_HOST"
[ -n "$SMTP_PORT" ] && setenv SMTP_PORT "$SMTP_PORT"
[ -n "$SMTP_USER" ] && setenv SMTP_USER "$SMTP_USER"
[ -n "$SMTP_PASS" ] && setenv SMTP_PASS "${SMTP_PASS// /}"
[ -n "$SMTP_FROM" ] && setenv SMTP_FROM "\"$SMTP_FROM\""
grep -q '^SESSION_DAYS=' "$ENV_FILE" || echo "SESSION_DAYS=30" >> "$ENV_FILE"
[ -n "$(getenv ADMIN_EMAILS)" ] || die "Pestis needs at least one admin. Re-run with:  --admin you@gmail.com"
echo "Admins: $(getenv ADMIN_EMAILS)"
if [ -n "$(getenv GOOGLE_CLIENT_ID)" ]; then echo "Google sign-in: ON"; else echo "Google sign-in: not set up yet (add --google-client-id, see SETUP.md)"; fi
if [ -n "$(getenv SMTP_HOST)" ]; then echo "Emailed sign-in links: ON ($(getenv SMTP_HOST))"; else echo "Emailed sign-in links: off (optional)"; fi

say "Installing Pestis"
id pestis >/dev/null 2>&1 || useradd --system --home /opt/pestis --shell "$(command -v nologin)" pestis
mkdir -p /opt/pestis "$DATA_DIR" "$BACKUP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin && git -C "$APP_DIR" reset -q --hard origin/main
else
  rm -rf "$APP_DIR"; git clone -q "$REPO" "$APP_DIR"
fi
echo "Version: $(git -C "$APP_DIR" log -1 --format='%h %s')"
chown -R pestis:pestis "$DATA_DIR" "$BACKUP_DIR"
chown root:pestis "$ENV_FILE"

cat > /etc/systemd/system/pestis.service <<UNIT
[Unit]
Description=Pestis server
After=network.target

[Service]
User=pestis
Group=pestis
Environment=PORT=${PORT}
Environment=HOST=127.0.0.1
Environment=DATA_DIR=${DATA_DIR}
Environment=PUBLIC_DIR=${APP_DIR}
# Sign-in and email settings live here:
EnvironmentFile=-${ENV_FILE}
ExecStart=${NODE_BIN} --disable-warning=ExperimentalWarning ${APP_DIR}/server/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable pestis >/dev/null
systemctl restart pestis
# the server takes a few seconds to start (longer with a big database, or just after the machine starts): wait up to a minute
ok=""
for i in $(seq 1 30); do sleep 2; if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then ok=1; break; fi; done
[ -n "$ok" ] || { journalctl -u pestis -n 30 --no-pager; die "The Pestis server did not start (log above)."; }
echo "Pestis server is running."

say "Automatic updates from GitHub (every 2 minutes)"
cat > /usr/local/bin/pestis-update <<UPD
#!/bin/sh
# Brings Pestis up to date with GitHub. The apps update straight away; the server restarts if it changed.
cd ${APP_DIR} || exit 1
git fetch -q origin || exit 0
[ "\$(git rev-parse HEAD)" = "\$(git rev-parse origin/main)" ] && exit 0
changed=\$(git diff --name-only HEAD origin/main)
git reset -q --hard origin/main
echo "\$(date -Is) updated to \$(git log -1 --format='%h %s')" >> /var/log/pestis-updates.log
echo "\$changed" | grep -q '^server/' && systemctl restart pestis
exit 0
UPD
chmod +x /usr/local/bin/pestis-update
echo "*/2 * * * * root /usr/local/bin/pestis-update" > /etc/cron.d/pestis-update
echo "Updates are logged in /var/log/pestis-updates.log"

say "Opening ports 80 and 443 in the VM firewall"
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
  echo "firewalld updated"
elif command -v iptables >/dev/null 2>&1; then
  for p in 80 443; do
    iptables -C INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp -m state --state NEW --dport "$p" -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1 || true
  else mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4; fi
  echo "iptables updated"
fi

say "Setting up HTTPS"
if [ -z "$DOMAIN" ]; then DOMAIN="$(getenv PESTIS_DOMAIN)"; fi
if [ -z "$DOMAIN" ]; then
  PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me || true)"
  [ -n "$PUBLIC_IP" ] || die "Could not find this VM's public IP. Re-run with a domain: sudo bash $0 --domain pestis.example.com"
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
fi
setenv PESTIS_DOMAIN "$DOMAIN"
[ -f /etc/caddy/Caddyfile ] && [ ! -f /etc/caddy/Caddyfile.before-pestis ] && cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-pestis
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
	# live updates go straight through, unbuffered
	@live path /api/live
	handle @live {
		reverse_proxy 127.0.0.1:${PORT} {
			flush_interval -1
		}
	}
	handle {
		encode gzip
		reverse_proxy 127.0.0.1:${PORT}
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
}
CADDY
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy

say "Nightly backups"
cat > /etc/cron.daily/pestis-backup <<BACKUP
#!/bin/sh
# the database every night; the photos, floor plans and documents every Sunday. 14 days kept.
sqlite3 ${DATA_DIR}/pestis.db ".backup '${BACKUP_DIR}/pestis-\$(date +%F).db'"
[ "\$(date +%u)" = 7 ] && tar -czf ${BACKUP_DIR}/files-\$(date +%F).tar.gz -C ${DATA_DIR} files
find ${BACKUP_DIR} -type f -mtime +14 -delete
id ubuntu >/dev/null 2>&1 && chown -R ubuntu ${BACKUP_DIR}
id opc >/dev/null 2>&1 && chown -R opc ${BACKUP_DIR}
exit 0
BACKUP
chmod +x /etc/cron.daily/pestis-backup
echo "Backups go to ${BACKUP_DIR}"

say "Checking HTTPS (can take up to a minute while the certificate is issued)"
ok=0
for i in $(seq 1 20); do
  if curl -fsS --max-time 10 "https://${DOMAIN}/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done

echo
echo "====================================================================="
if [ "$ok" = 1 ]; then
  echo " Pestis is live:"
else
  echo " Pestis is installed, but https://${DOMAIN} is not answering yet."
  echo " Most likely ports 80/443 are not open in the Oracle Cloud console"
  echo " (instance > Primary VNIC > Subnet > Security List). Fix that, then run:"
  echo "   sudo systemctl restart caddy"
  echo " The addresses will be:"
fi
echo "   Service App     https://${DOMAIN}/"
echo "   Admin           https://${DOMAIN}/admin.html"
echo "   Client Portal   https://${DOMAIN}/client.html"
echo
echo " In Google Cloud (APIs & Services > Credentials > your OAuth client):"
echo "   Authorized JavaScript origins:  https://${DOMAIN}"
echo "   Authorized redirect URIs:       https://${DOMAIN}/auth/callback"
if [ -z "$(getenv GOOGLE_CLIENT_ID)" ]; then
  echo " Then switch Google sign-in on:"
  echo "   sudo bash $0 --google-client-id YOUR_CLIENT_ID"
fi
echo
echo " Logs:     sudo journalctl -u pestis -f"
echo " Data:     ${DATA_DIR}   Backups: ${BACKUP_DIR}"
echo " Settings: ${ENV_FILE}   (then: sudo systemctl restart pestis)"
echo "====================================================================="
