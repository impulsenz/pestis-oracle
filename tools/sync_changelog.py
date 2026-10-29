# puts the shared "What's new" list (changelog_shared.js) into the Service App, the Client Portal and the Admin source, identically
import re
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + '/'
SP = ROOT + 'src/'
js = open(SP + 'changelog_shared.js').read().strip()
RX = re.compile(r'/\* PESTIS-CHANGELOG:BEGIN.*?/\* PESTIS-CHANGELOG:END \*/', re.S)
for p in [ROOT + 'index.html', ROOT + 'client.html']:
    s = open(p).read()
    if not RX.search(s):
        j = s.rindex('</body>'); s = s[:j] + '<script id="pestisChangelogJs">\n/* PESTIS-CHANGELOG:BEGIN */\n/* PESTIS-CHANGELOG:END */\n</script>\n' + s[j:]
    s = RX.sub(lambda m: js, s, count=1)
    open(p, 'w').write(s); print('synced', p)
p = SP + 'admin_src.html'; s = open(p).read()
if not RX.search(s):
    k = s.index('<script type="text/plain" id="addonScript">') + len('<script type="text/plain" id="addonScript">')
    s = s[:k] + '\n' + js + '\n' + s[k:]
else:
    s = RX.sub(lambda m: js, s, count=1)
open(p, 'w').write(s); print('synced admin_src.html')
