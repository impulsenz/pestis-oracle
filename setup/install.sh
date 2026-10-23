#!/usr/bin/env bash
# =====================================================================================
#  Pestis on Oracle Cloud - sets up the whole server. Run it as root from the app folder:
#      sudo bash /opt/pestis/app/setup/install.sh
#  It is safe to run again (after changing /opt/pestis/pestis.env, or to repair something):
#  it never makes new passwords once they exist and never deletes your data.
#
#  What it does:
#   1. installs Docker, Caddy (the web server that gets the https certificate) and the tools it needs
#   2. opens the web ports (80, 443) in the server's own firewall, and keeps the database ports closed
#   3. downloads Supabase's self-hosting files to /opt/supabase and makes its secret keys (once)
#   4. sets Supabase up for your web address, Google sign-in and email, and starts it
#   5. builds the Pestis database (sql/install.sql) and makes ADMIN_EMAIL the first admin
#   6. writes config.js (the apps' connection details) and the Caddy settings, and starts serving
#   7. adds the jobs: the apps update from GitHub every 2 minutes; the database is backed up nightly
# =====================================================================================
set -euo pipefail
APP=/opt/pestis/app
CONF=/opt/pestis/pestis.env
SECRETS=/opt/pestis/secrets.env
SB=/opt/supabase
say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mSTOPPED: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || die "run it with sudo:  sudo bash $APP/setup/install.sh"
[ -f "$APP/index.html" ] || die "the apps aren't in $APP - clone the repository there first (SETUP.md step 8)"
[ -f "$CONF" ] || die "fill in your settings first:  sudo cp $APP/setup/pestis.env.example $CONF && sudo nano $CONF"
# shellcheck disable=SC1090
source "$CONF"
for v in PESTIS_DOMAIN CERT_EMAIL ADMIN_EMAIL GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
    val="${!v:-}"
    [ -n "$val" ] || die "$v is empty in $CONF"
    case "$val" in *yourname*|*example.com*|*xxxx*|1234567890-*) die "$v in $CONF still has the example value";; esac
done
PESTIS_DOMAIN="${PESTIS_DOMAIN#https://}"; PESTIS_DOMAIN="${PESTIS_DOMAIN%/}"
URL="https://$PESTIS_DOMAIN"

say "1/7 Installing Docker, Caddy and tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg python3 cron iptables-persistent netfilter-persistent debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh >/dev/null; fi
systemctl enable --now docker >/dev/null
if id ubuntu >/dev/null 2>&1; then usermod -aG docker ubuntu || true; fi
if ! command -v caddy >/dev/null; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

say "2/7 Firewall: web ports open, database ports closed to the internet"
# Oracle's Ubuntu image only lets SSH in; add the web ports above its "reject everything else" rule
iptables -C INPUT -p tcp -m multiport --dports 80,443 -m state --state NEW -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -m state --state NEW -j ACCEPT
# Docker's published ports skip that list, so also block Supabase's own ports from outside (Caddy reaches them on the server itself)
EXT_IF=$(ip route show default | awk '{print $5; exit}')
iptables -N DOCKER-USER 2>/dev/null || true
for p in 5432 6543 8000 8443 3000 4000; do
    iptables -C DOCKER-USER -i "$EXT_IF" -p tcp -m conntrack --ctorigdstport "$p" --ctdir ORIGINAL -j DROP 2>/dev/null \
        || iptables -I DOCKER-USER -i "$EXT_IF" -p tcp -m conntrack --ctorigdstport "$p" --ctdir ORIGINAL -j DROP
done
netfilter-persistent save >/dev/null 2>&1 || true

say "3/7 Supabase files and secret keys"
if [ ! -f "$SB/docker-compose.yml" ]; then
    tmp=$(mktemp -d)
    git clone -q --depth 1 --filter=blob:none --sparse https://github.com/supabase/supabase "$tmp/sb"
    git -C "$tmp/sb" sparse-checkout set docker
    mkdir -p "$SB" && cp -rf "$tmp/sb/docker/." "$SB/" && rm -rf "$tmp"
fi
[ -f "$SB/.env" ] || cp "$SB/.env.example" "$SB/.env"
if [ ! -f "$SECRETS" ]; then python3 "$APP/setup/make-keys.py" > "$SECRETS"; chmod 600 "$SECRETS"; echo "   made new keys and passwords: $SECRETS"; fi
# shellcheck disable=SC1090
source "$SECRETS"

say "4/7 Supabase settings (web address, Google sign-in, email) and start"
# sets KEY=value in .env (replacing the line if it's there)
setenv() { python3 - "$SB/.env" "$1" "$2" <<'PY'
import re, sys
p, k, v = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
line = f'{k}={v}'
s, n = re.subn(rf'^{re.escape(k)}=.*$', lambda m: line, s, flags=re.M)
if not n: s = s.rstrip('\n') + '\n' + line + '\n'
open(p, 'w').write(s)
PY
}
for k in POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY DASHBOARD_USERNAME DASHBOARD_PASSWORD SECRET_KEY_BASE VAULT_ENC_KEY PG_META_CRYPTO_KEY LOGFLARE_PUBLIC_ACCESS_TOKEN LOGFLARE_PRIVATE_ACCESS_TOKEN LOGFLARE_API_KEY POOLER_TENANT_ID; do
    setenv "$k" "${!k}"
done
setenv SITE_URL "$URL/index.html"
setenv ADDITIONAL_REDIRECT_URLS "$URL/**"
setenv API_EXTERNAL_URL "$URL"
setenv SUPABASE_PUBLIC_URL "$URL"
setenv DISABLE_SIGNUP "false"
setenv ENABLE_EMAIL_SIGNUP "true"
setenv ENABLE_EMAIL_AUTOCONFIRM "false"
setenv ENABLE_ANONYMOUS_USERS "false"
setenv ENABLE_PHONE_SIGNUP "false"
setenv ENABLE_PHONE_AUTOCONFIRM "false"
setenv GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID"
setenv GOOGLE_CLIENT_SECRET "$GOOGLE_CLIENT_SECRET"
if [ -n "${SMTP_HOST:-}" ]; then
    setenv SMTP_HOST "$SMTP_HOST"; setenv SMTP_PORT "${SMTP_PORT:-587}"; setenv SMTP_USER "$SMTP_USER"; setenv SMTP_PASS "$SMTP_PASS"
    setenv SMTP_SENDER_NAME "${SMTP_SENDER_NAME:-Pesties}"; setenv SMTP_ADMIN_EMAIL "${SMTP_ADMIN_EMAIL:-$SMTP_USER}"
fi
chmod 600 "$SB/.env"
# Google sign-in for Supabase's sign-in service (not in Supabase's standard file)
cat > "$SB/docker-compose.override.yml" <<'YML'
# Pestis: Google sign-in (values come from .env)
services:
  auth:
    environment:
      GOTRUE_EXTERNAL_GOOGLE_ENABLED: "true"
      GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
      GOTRUE_EXTERNAL_GOOGLE_SECRET: ${GOOGLE_CLIENT_SECRET}
      GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI: ${API_EXTERNAL_URL}/auth/v1/callback
YML
left=$(grep -nE '^[A-Z_]+=.*(your-super-secret|this_password_is_insecure|your-encryption-key|your-tenant-id)' "$SB/.env" || true)
[ -z "$left" ] || echo "   NOTE: these lines in $SB/.env still have Supabase's example values (newer Supabase setting?): $left"
cd "$SB"
docker compose pull -q
docker compose up -d
echo "   waiting for the database and sign-in service to be ready..."
dbq() { docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db psql -h 127.0.0.1 -U postgres -d postgres -tA "$@"; }
for i in $(seq 1 90); do
    if [ "$(dbq -c "select (to_regclass('auth.users') is not null and to_regclass('storage.buckets') is not null)::text" 2>/dev/null || true)" = "true" ]; then break; fi
    sleep 4
    [ "$i" = 90 ] && die "Supabase didn't finish starting. See:  cd $SB && docker compose ps  and  docker compose logs auth db storage"
done

say "5/7 The Pestis database"
dbq -v ON_ERROR_STOP=1 -q < "$APP/sql/install.sql" >/dev/null
dbq -q <<SQL
-- every table the apps use can be reached by signed-in people; the row rules decide what each one sees
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
-- the first admin
insert into public.allowed_emails (email, role) values (lower('$ADMIN_EMAIL'), 'admin')
    on conflict (email) do update set role = 'admin';
update public.profiles set approved = true, role = 'admin' where lower(email) = lower('$ADMIN_EMAIL');
notify pgrst, 'reload schema';
SQL
echo "   database ready; $ADMIN_EMAIL is the admin"

say "6/7 The apps' connection details and the web server"
cat > "$APP/config.js" <<JS
// made by setup/install.sh - the apps' connection to your own Supabase (the anon key is the public one)
window.PESTIS_CONFIG = { url: '$URL', anonKey: '$ANON_KEY' };
JS
chmod 644 "$APP/config.js"
cat > /etc/caddy/Caddyfile <<CADDY
# made by setup/install.sh
{
    email $CERT_EMAIL
}
$PESTIS_DOMAIN {
    encode zstd gzip
    header {
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
        -Server
    }
    # Supabase: sign-in, the database, files, live updates (Supabase's dashboard is NOT exposed - use an SSH tunnel)
    @api path /auth/v1/* /rest/v1/* /storage/v1/* /realtime/v1/* /functions/v1/* /graphql/v1/*
    handle @api {
        reverse_proxy 127.0.0.1:8000
    }
    # the apps (only these files - not the setup scripts or SQL)
    @app path / /index.html /admin.html /client.html /sw.js /config.js /images/*
    handle @app {
        root * $APP
        @fresh path / *.html /sw.js /config.js
        header @fresh Cache-Control "no-cache"
        file_server
    }
    handle {
        respond "Not found" 404
    }
}
CADDY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "7/7 App updates and nightly backups"
chmod +x "$APP/setup/update-app.sh" "$APP/setup/backup.sh"
cat > /etc/cron.d/pestis <<CRON
# made by setup/install.sh
*/2 * * * * root $APP/setup/update-app.sh >/dev/null 2>&1
30 2 * * * root $APP/setup/backup.sh >> /var/log/pestis-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/pestis
mkdir -p /opt/pestis/backups

cat <<DONE

==========================================================================
 Pestis is set up.
   Service App:    $URL/
   Admin:          $URL/admin.html
   Client Portal:  $URL/client.html
 Sign in with Google using $ADMIN_EMAIL - you're the admin.
 (The certificate can take a minute on the very first visit.)

 Supabase's dashboard (Studio), only through an SSH tunnel from your computer:
   ssh -i <your key> -L 8000:127.0.0.1:8000 ubuntu@<server ip>
   then open http://localhost:8000   user: $DASHBOARD_USERNAME   password: in $SECRETS
 Keys and passwords: $SECRETS (keep a copy somewhere safe)
==========================================================================
DONE
