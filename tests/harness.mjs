// Test harness: fake Google signing keys + fake SMTP server + starts the Pestis server.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STUBS_DIR = path.join(ROOT, 'tests', 'stubs');
export const tmpDir = name => path.join(os.tmpdir(), 'pestis-test-' + name);
// Playwright: from this folder, or the one installed for the whole machine
export function playwright() {
  try { return createRequire(import.meta.url)('playwright'); } catch {}
  const g = execSync('npm root -g').toString().trim();
  return createRequire(g + '/')('playwright');
}

export const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256', use: 'sig' });
export const mails = [];

export function idToken(email, extra = {}) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(Object.assign({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: email, email, email_verified: true,
    name: email.split('@')[0], exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000) }, extra))).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

// keep: start on the data already in dataDir (a restart) instead of a fresh, empty database
export async function start({ port, dataDir, admins = 'boss@example.com', keep = false }) {
  const keys = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' }); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise(r => keys.listen(0, '127.0.0.1', r));
  // a tiny SMTP server that keeps every message
  const smtp = net.createServer(sock => {
    let data = false, buf = '', msg = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === '.') { data = false; mails.push(msg); msg = ''; sock.write('250 ok\r\n'); } else msg += line + '\n'; continue; }
        if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH/i.test(line)) sock.write('235 ok\r\n');
        else if (/^DATA/i.test(line)) { data = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  if (!keep) fs.rmSync(dataDir, { recursive: true, force: true });
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'server.mjs')], {
    env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, GOOGLE_CLIENT_ID: CLIENT_ID, ADMIN_EMAILS: admins,
      GOOGLE_CERTS_URL: `http://127.0.0.1:${keys.address().port}/certs`, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port),
      SMTP_SECURE: 'none', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'Pestis <noreply@example.com>' }),
    stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', d => { log += d; if (process.env.SHOWLOG) process.stdout.write('[srv] ' + d); });
  proc.stderr.on('data', d => { log += d; process.stderr.write('[srv!] ' + d); });
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  return { stop: () => { proc.kill(); keys.close(); smtp.close(); }, log: () => log };
}
