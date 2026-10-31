// Pestis offline app cache.
// Keeps the app and its libraries available with no connection. Photos are NOT stored on the device.
// Calls to the Pestis server are NOT cached here - the app's own upload queue handles data.

const SHELL_CACHE = 'pestis-oci-shell-v106';
const RUNTIME_CACHE = 'pestis-oci-runtime-v106';

const SHELL = ['./', './index.html', './admin.html', './pestis-db.js', './images/pesties-logo.png'];   // admin.html: the app's add-ons (Admin, profile, Settings)
const CDN = [
    'https://cdn.tailwindcss.com',
    'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];
const CDN_HOSTS = ['cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        await Promise.all([
            ...SHELL.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})),
            ...CDN.map(u => fetch(u, { mode: 'no-cors' }).then(r => cache.put(u, r)).catch(() => {}))
        ]);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keep = [SHELL_CACHE, RUNTIME_CACHE]; // any photo cache from older versions is deleted
        for (const k of await caches.keys()) if (k.startsWith('pestis-oci-') && !keep.includes(k)) await caches.delete(k);
        await self.clients.claim();
    })());
});

// Weak or no signal: a request can hang for a minute instead of failing. Give the server a few
// seconds, then answer from the saved copy; the download carries on and refreshes the saved copy.
const NET_WAIT_MS = 4000;
function fetchAndSave(url, key) {
    return fetch(url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
        if (res.ok) caches.open(SHELL_CACHE).then(c => c.put(key, res.clone())).catch(() => {});
        return res;
    });
}
async function networkOrSaved(url, key, savedLookup) {
    const net = fetchAndSave(url, key);
    net.catch(() => {});
    const timer = new Promise(r => setTimeout(() => r('slow'), NET_WAIT_MS));
    try {
        const first = await Promise.race([net, timer]);
        if (first !== 'slow') return first;
    } catch (e) { /* no connection: use the saved copy */ }
    const saved = await savedLookup();
    if (saved) return saved;
    return net;   // nothing saved yet: wait for the server after all
}

async function trimCache(name, max) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    // the Pestis server (same address): data, sign-in, photos, documents and live updates always go straight to it
    if (url.origin === self.location.origin && /^\/(api|rest|auth)\//.test(url.pathname)) return;

    // App page: try the network first, fall back to the saved copy when offline
    if (req.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                // Always check the server for a newer copy of the app (skips the browser's own cache)
                const res = await networkOrSaved(req.url, url.origin + url.pathname,
                    async () => (await caches.match(url.origin + url.pathname)) || (await caches.match(req, { ignoreSearch: true })));
                if (res) return res;
                throw new Error('no copy');
            } catch (e) {
                const saved = (await caches.match(url.origin + url.pathname)) || (await caches.match(req, { ignoreSearch: true }));
                if (saved) return saved;
                // the Client Portal is an online page: never show the staff app in its place
                if (/client\.html$/.test(url.pathname)) {
                    return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pesties Client Portal</title>' +
                        '<body style="font-family:system-ui,sans-serif;background:#060d1f;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:1rem">' +
                        '<div><h1 style="font-size:1.2rem">You\'re offline</h1><p style="color:#9db0d1">The Client Portal needs an internet connection. Please reconnect and try again.</p></div></body>',
                        { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                }
                return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
            }
        })());
        return;
    }

    // admin.html, index.html when the Admin site loads it, and the database connection (it must match the app's version):
    // the newest from the server, the saved copy when offline
    if (url.origin === self.location.origin && /\/((admin|index)\.html|pestis-db\.js)$/.test(url.pathname)) {
        event.respondWith((async () => {
            try {
                return await networkOrSaved(req.url, url.origin + url.pathname, () => caches.match(url.origin + url.pathname));
            } catch (e) {
                return (await caches.match(url.origin + url.pathname)) || (await caches.match('./admin.html')) || Response.error();
            }
        })());
        return;
    }

    // Photos are never kept on the device: they load from the server only when opened
    if (url.hostname.endsWith('.supabase.co') && url.pathname.includes('/storage/')) return;

    // Everything else from Supabase (database, auth) goes straight to the network
    if (url.hostname.endsWith('.supabase.co')) return;

    // App files and libraries: serve the saved copy instantly, refresh it in the background
    if (url.origin === self.location.origin || CDN_HOSTS.includes(url.hostname)) {
        event.respondWith((async () => {
            const cached = await caches.match(req);
            const network = fetch(req).then(async res => {
                if (res && (res.ok || res.type === 'opaque')) {
                    const cache = await caches.open(RUNTIME_CACHE);
                    await cache.put(req, res.clone());
                    trimCache(RUNTIME_CACHE, 80).catch(() => {});   // keeps the saved files from growing without limit
                }
                return res;
            }).catch(() => null);
            return cached || (await network) || Response.error();
        })());
    }
});
