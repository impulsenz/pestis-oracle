# Makes the Pestis-server copies of the three apps from the originals (impulsenz/Pesties, which are left untouched).
#   python3 make_server_copy.py <originals folder> <output folder>
# Changes:
#  - the database is the Pestis server at the same web address as the apps (SQLite on your Oracle Cloud server):
#    pestis-db.js takes the place of the supabase-js library
#  - the offline copy (service worker) has its own cache names, keeps pestis-db.js, and never caches the server's data,
#    sign-in or photo traffic
#  - the version shows "oci" so you can tell the copies apart
import re, sys, os, shutil
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

CFG = """const SUPABASE_URL = location.origin;              // the Pestis server: same address as the apps
const SUPABASE_ANON_KEY = 'pestis-server';          // not used by the Pestis server (kept so the app code stays the same)"""

def convert(name):
    s = open(os.path.join(src, name)).read()
    pat = re.compile(r"^(\s*)const SUPABASE_URL = '[^']*';\n\s*const SUPABASE_ANON_KEY = '[^']*';", re.M)
    m = pat.search(s); assert m, name + ': no Supabase settings found'
    ind = m.group(1)
    s = s[:m.start()] + '\n'.join(ind + l for l in CFG.split('\n')) + s[m.end():]
    lib = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>'
    assert s.count(lib) == 1, name + ': supabase-js script tag not found once'
    s = s.replace(lib, '<script src="pestis-db.js"></script>')
    s = s.replace("The sign-in library (supabase-js) did not download - check the internet connection or any ad / content blocker.",
                  "The database connection (pestis-db.js) did not load - check the internet connection.")
    # versions: "-oci" so the copies are easy to tell apart
    s = re.sub(r"(const APP_VERSION = '[^']*)'", r"\1-oci'", s)
    s = re.sub(r"(const PORTAL_VERSION = '[^']*)'", r"\1-oci'", s)
    s = re.sub(r"(Version \d{4}\.\d\d\.\d\d-a\d+)", r"\1-oci", s)
    s = re.sub(r"(version: '\d{4}\.\d\d\.\d\d-a\d+)'", r"\1-oci'", s)
    # the help text points at the Pestis server instead of the Supabase dashboard
    s = s.replace('in the Supabase SQL editor', 'on the Pestis server (it updates the database itself when it restarts)')
    s = s.replace('in the Supabase SQL Editor', 'on the Pestis server (it updates the database itself when it restarts)')
    open(os.path.join(out, name), 'w').write(s)
    print('made', name)

for n in ('index.html', 'admin.html', 'client.html'): convert(n)

w = open(os.path.join(src, 'sw.js')).read()
w = re.sub(r"'pestis-shell-v(\d+)'", r"'pestis-oci-shell-v\1'", w)
w = re.sub(r"'pestis-runtime-v(\d+)'", r"'pestis-oci-runtime-v\1'", w)
assert "pestis-oci-shell" in w and "pestis-oci-runtime" in w
old_shell = "const SHELL = ['./', './index.html', './admin.html', './images/pesties-logo.png'];"
assert old_shell in w
w = w.replace(old_shell, "const SHELL = ['./', './index.html', './admin.html', './pestis-db.js', './images/pesties-logo.png'];")
assert "    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',\n" in w
w = w.replace("    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',\n", "")
w = w.replace("for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);",
              "for (const k of await caches.keys()) if (k.startsWith('pestis-oci-') && !keep.includes(k)) await caches.delete(k);")
assert "k.startsWith('pestis-oci-')" in w
i = w.index("self.addEventListener('fetch', event => {")
j = w.index("const url = new URL(req.url);", i) + len("const url = new URL(req.url);")
w = w[:j] + """
    // the Pestis server (same address): data, sign-in, photos, documents and live updates always go straight to it
    if (url.origin === self.location.origin && /^\\/(api|rest|auth)\\//.test(url.pathname)) return;""" + w[j:]
w = w.replace("// Database calls are NOT cached here", "// Calls to the Pestis server are NOT cached here")
open(os.path.join(out, 'sw.js'), 'w').write(w)
print('made sw.js')
if os.path.isdir(os.path.join(src, 'images')): shutil.copytree(os.path.join(src, 'images'), os.path.join(out, 'images'), dirs_exist_ok=True)
