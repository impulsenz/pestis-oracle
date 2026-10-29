# puts the shared visit report PDF code (visitpdf_shared.js) into the Service App and the Client Portal, identically
import re
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + '/'
js = open(ROOT + 'src/visitpdf_shared.js', encoding='utf-8').read().strip()
RX = re.compile(r'/\* PESTIS-VISITPDF:BEGIN.*?/\* PESTIS-VISITPDF:END \*/', re.S)
for name in ('index.html', 'client.html'):
    p = ROOT + name
    s = open(p, encoding='utf-8').read()
    if not RX.search(s):
        # its own script tag, just before the end of the page
        j = s.rindex('</body>')
        s = s[:j] + '<script id="pestisVisitPdf">\n/* PESTIS-VISITPDF:BEGIN */\n/* PESTIS-VISITPDF:END */\n</script>\n' + s[j:]
    s = RX.sub(lambda m: js, s, count=1)
    open(p, 'w', encoding='utf-8').write(s)
    print('synced', name)
