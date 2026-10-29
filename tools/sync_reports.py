# puts the shared reports code (reports_shared.js / .css) into the Client Portal and the Admin source, identically
import re
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + '/'
SP = ROOT + 'src/'
js = open(SP + 'reports_shared.js').read().strip()
css = open(SP + 'reports_shared.css').read().strip()
JS_RE = re.compile(r'/\* PESTIS-REPORTS:BEGIN.*?/\* PESTIS-REPORTS:END \*/', re.S)
CSS_RE = re.compile(r'/\* PESTIS-REPORTS-CSS:BEGIN \*/.*?/\* PESTIS-REPORTS-CSS:END \*/', re.S)
def put(s, rx, block, before):
    if rx.search(s): return rx.sub(lambda m: block, s)
    i = s.index(before)
    return s[:i] + block + '\n' + s[i:]
# Client Portal: in its own style and script tags
p = ROOT + 'client.html'; s = open(p).read()
if 'id="pestisReportsCss"' not in s:
    i = s.index('</head>'); s = s[:i] + '<style id="pestisReportsCss">\n/* PESTIS-REPORTS-CSS:BEGIN */\n/* PESTIS-REPORTS-CSS:END */\n</style>\n' + s[i:]
    j = s.rindex('</body>'); s = s[:j] + '<script id="pestisReportsJs">\n/* PESTIS-REPORTS:BEGIN */\n/* PESTIS-REPORTS:END */\n</script>\n' + s[j:]
s = CSS_RE.sub(lambda m: css, s, count=1); s = JS_RE.sub(lambda m: js, s, count=1)
open(p, 'w').write(s); print('synced client.html')
# Admin source: inside its style and its add-on script (that's what build_admin.py takes)
p = SP + 'admin_src.html'; s = open(p).read()
s = put(s, CSS_RE, css, '</style>')
if not JS_RE.search(s):
    k = s.index('<script type="text/plain" id="addonScript">') + len('<script type="text/plain" id="addonScript">')
    s = s[:k] + '\n' + js + '\n' + s[k:]
else:
    s = JS_RE.sub(lambda m: js, s, count=1)
open(p, 'w').write(s); print('synced admin_src.html')
