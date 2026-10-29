// A small email sender (SMTP), for the Client Portal's "Email me a sign-in link". No npm packages needed.
// Works with Gmail (smtp.gmail.com, port 587 + an app password), Brevo, Resend, Microsoft 365 and most others.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';

function reader(sock) {
  let buf = '', waiting = null, closed = null;
  const tryResolve = () => {
    if (!waiting) return;
    const lines = buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const text = lines.slice(0, i + 1).join('\n');
        buf = lines.slice(i + 1).join('\r\n');
        const w = waiting; waiting = null; w.resolve({ code: Number(lines[i].slice(0, 3)), text });
        return;
      }
    }
  };
  const onData = d => { buf += d.toString('utf8'); tryResolve(); };
  const onEnd = () => { closed = new Error('The email server closed the connection'); if (waiting) { const w = waiting; waiting = null; w.reject(closed); } };
  sock.on('data', onData); sock.on('error', e => { closed = e; if (waiting) { const w = waiting; waiting = null; w.reject(e); } }); sock.on('end', onEnd);
  return {
    next: () => new Promise((resolve, reject) => { if (closed) return reject(closed); waiting = { resolve, reject }; tryResolve(); }),
    detach: () => { sock.removeListener('data', onData); sock.removeListener('end', onEnd); },
  };
}

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = s => s.replace(/.{1,76}/g, '$&\r\n');
const encHeader = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;

export function buildMessage({ from, to, subject, text, html }) {
  const boundary = 'pestis-' + crypto.randomBytes(12).toString('hex');
  const domain = (String(from).match(/@([^>\s]+)/) || [])[1] || 'pestis.local';
  const fromName = /</.test(from) ? from.replace(/^\s*"?([^"<]*?)"?\s*<(.+)>\s*$/, (m, n, a) => (n ? encHeader(n) + ' ' : '') + '<' + a + '>') : from;
  return [
    `From: ${fromName}`, `To: ${to}`, `Subject: ${encHeader(subject)}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${domain}>`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(text)),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(html || text)),
    `--${boundary}--`, '',
  ].join('\r\n');
}

// opts: { host, port, secure: 'ssl' | 'starttls' | 'none', user, pass, from, to, subject, text, html }
export async function sendMail(opts) {
  const port = Number(opts.port || 587);
  const secure = opts.secure || (port === 465 ? 'ssl' : 'starttls');
  const timeout = 20000;
  let sock = await new Promise((resolve, reject) => {
    const s = secure === 'ssl' ? tls.connect({ host: opts.host, port, servername: opts.host }) : net.connect({ host: opts.host, port });
    s.setTimeout(timeout, () => s.destroy(new Error('The email server took too long to answer')));
    s.once(secure === 'ssl' ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', reject);
  });
  let r = reader(sock);
  const say = async (line, ok) => {
    if (line != null) sock.write(line + '\r\n');
    const res = await r.next();
    if (!ok.includes(res.code)) throw new Error(`Email server said: ${res.text.replace(/\n/g, ' ').slice(0, 300)}`);
    return res;
  };
  try {
    await say(null, [220]);
    const me = os.hostname() || 'pestis';
    let ehlo = await say('EHLO ' + me, [250]);
    if (secure === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error("The email server doesn't offer a secure connection (STARTTLS) on this port");
      await say('STARTTLS', [220]);
      r.detach();
      sock = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: sock, servername: opts.host }, () => resolve(s));
        s.once('error', reject);
      });
      sock.setTimeout(timeout, () => sock.destroy(new Error('The email server took too long to answer')));
      r = reader(sock);
      ehlo = await say('EHLO ' + me, [250]);
    }
    if (opts.user) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) await say('AUTH PLAIN ' + Buffer.from(`\0${opts.user}\0${opts.pass || ''}`).toString('base64'), [235]);
      else { await say('AUTH LOGIN', [334]); await say(b64(opts.user), [334]); await say(b64(opts.pass || ''), [235]); }
    }
    const addr = s => (String(s).match(/<([^>]+)>/) || [null, s])[1].trim();
    await say(`MAIL FROM:<${addr(opts.from)}>`, [250]);
    await say(`RCPT TO:<${addr(opts.to)}>`, [250, 251]);
    await say('DATA', [354]);
    const body = buildMessage(opts).replace(/\r\n\./g, '\r\n..');
    await say(body + '\r\n.', [250]);
    sock.write('QUIT\r\n');
  } finally {
    setTimeout(() => sock.destroy(), 500).unref();
  }
}
