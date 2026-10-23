# Makes the Oracle Cloud copies of the three Pestis apps from the originals (which are left untouched).
#   python3 make_oci.py <originals folder> <output folder>
# Changes:
#  - the database is your own Supabase at the same web address as the apps (Caddy sends /auth, /rest,
#    /storage, /realtime ... to Supabase); its public key comes from config.js, made on the server
#  - the offline copy (service worker) has its own cache names and never caches the database's traffic
#  - the version shows "oci" so you can tell the copies apart
import re, sys, os, shutil
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

CFG = """const PESTIS_CFG = (typeof window !== 'undefined' && window.PESTIS_CONFIG) || {};   // config.js, made on the server
const SUPABASE_URL = String(PESTIS_CFG.url || location.origin).replace(/\\/+$/, '');           // your own Supabase (same address as the apps)
const SUPABASE_ANON_KEY = PESTIS_CFG.anonKey || '';"""
MISSING = """if (!SUPABASE_ANON_KEY) document.addEventListener('DOMContentLoaded', () => { const b = document.createElement('div'); b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b91c1c;color:#fff;font:700 13px system-ui,sans-serif;padding:10px 14px;text-align:center;'; b.textContent = "This copy of Pestis isn't connected to its server yet: config.js is missing on the server (see SETUP.md, step 9)."; document.body.appendChild(b); });"""

def convert(name):
    s = open(os.path.join(src, name)).read()
    # the server's address and key
    pat = re.compile(r"^(\s*)const SUPABASE_URL = '[^']*';\n\s*const SUPABASE_ANON_KEY = '[^']*';", re.M)
    m = pat.search(s); assert m, name + ': no Supabase settings found'
    ind = m.group(1)
    s = s[:m.start()] + '\n'.join(ind + l for l in (CFG + '\n' + MISSING).split('\n')) + s[m.end():]
    # config.js loads first (it sets window.PESTIS_CONFIG)
    h = s.index('<head>'); assert h < 3000, name + ': the page head should be near the top'
    s = s[:h] + '<head>\n    <script src="config.js"></script>' + s[h + 6:]
    # versions: "-oci" so the copies are easy to tell apart
    s = re.sub(r"(const APP_VERSION = '[^']*)'", r"\1-oci'", s)
    s = re.sub(r"(const PORTAL_VERSION = '[^']*)'", r"\1-oci'", s)
    s = re.sub(r"(Version \d{4}\.\d\d\.\d\d-a\d+)", r"\1-oci", s)
    s = re.sub(r"(version: '\d{4}\.\d\d\.\d\d-a\d+)'", r"\1-oci'", s)
    s = s.replace('<title>Pestis', '<title>Pestis (Oracle)', 1) if '<title>Pestis' in s else s
    open(os.path.join(out, name), 'w').write(s)
    print('made', name)

for n in ('index.html', 'admin.html', 'client.html'): convert(n)

# the service worker: own cache names, config.js kept offline, database traffic never cached
w = open(os.path.join(src, 'sw.js')).read()
w = re.sub(r"'pestis-shell-v(\d+)'", r"'pestis-oci-shell-v\1'", w)
w = re.sub(r"'pestis-runtime-v(\d+)'", r"'pestis-oci-runtime-v\1'", w)
assert "pestis-oci-shell" in w and "pestis-oci-runtime" in w
w = w.replace("const SHELL = ['./', './index.html', './admin.html', './images/pesties-logo.png'];",
              "const SHELL = ['./', './index.html', './admin.html', './config.js', './images/pesties-logo.png'];")
assert "'./config.js'" in w
# only this app's caches are cleared on an update (another app on the same address keeps its own)
w = w.replace("for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);",
              "for (const k of await caches.keys()) if (k.startsWith('pestis-oci-') && !keep.includes(k)) await caches.delete(k);")
assert "k.startsWith('pestis-oci-')" in w
i = w.index("self.addEventListener('fetch', event => {")
j = w.index("const url = new URL(req.url);", i) + len("const url = new URL(req.url);")
w = w[:j] + """
    // your Supabase is at the same address: sign-in, the database, files and live updates always go to the server
    if (url.origin === self.location.origin && /^\\/(auth|rest|storage|realtime|functions|graphql|pg|analytics)\\/v?\\d*/.test(url.pathname)) return;""" + w[j:]
open(os.path.join(out, 'sw.js'), 'w').write(w)
print('made sw.js')
if os.path.isdir(os.path.join(src, 'images')): shutil.copytree(os.path.join(src, 'images'), os.path.join(out, 'images'), dirs_exist_ok=True)
