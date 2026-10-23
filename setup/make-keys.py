#!/usr/bin/env python3
# Makes the secret keys your Supabase needs (run once by install.sh; the result is kept in /opt/pestis/secrets.env).
# The anon key is the app's public key (it's safe in the browser - the database rules decide what it can do);
# the service-role key and every password stay on the server.
import base64, hashlib, hmac, json, secrets, string, sys, time

def b64(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
def jwt(payload, secret):
    head = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    body = b64(json.dumps(payload, separators=(',', ':')).encode())
    sig = b64(hmac.new(secret.encode(), f'{head}.{body}'.encode(), hashlib.sha256).digest())
    return f'{head}.{body}.{sig}'
def pw(n): return ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(n))

jwt_secret = pw(48)
now = int(time.time()); ten_years = now + 10 * 365 * 24 * 3600
out = {
    'POSTGRES_PASSWORD': pw(32),
    'JWT_SECRET': jwt_secret,
    'ANON_KEY': jwt({'role': 'anon', 'iss': 'supabase', 'iat': now, 'exp': ten_years}, jwt_secret),
    'SERVICE_ROLE_KEY': jwt({'role': 'service_role', 'iss': 'supabase', 'iat': now, 'exp': ten_years}, jwt_secret),
    'DASHBOARD_USERNAME': 'pestis',
    'DASHBOARD_PASSWORD': pw(24),
    'SECRET_KEY_BASE': pw(64),
    'VAULT_ENC_KEY': pw(32),
    'PG_META_CRYPTO_KEY': pw(32),
    'LOGFLARE_PUBLIC_ACCESS_TOKEN': pw(40),
    'LOGFLARE_PRIVATE_ACCESS_TOKEN': pw(40),
    'LOGFLARE_API_KEY': pw(40),
    'POOLER_TENANT_ID': 'pestis',
}
for k, v in out.items(): print(f'{k}="{v}"')
