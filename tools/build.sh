#!/usr/bin/env bash
# Rebuilds the parts of the apps that are made from shared pieces. Run after changing anything in src/
# or the Service App (index.html), before testing and pushing:
#   1. src/changelog_shared.js  -> the "What's new" list in index.html, client.html and src/admin_src.html
#   2. src/reports_shared.js/.css -> the reports in client.html and src/admin_src.html
#   3. admin.html is made from index.html + src/admin_src.html (never edit admin.html by hand)
set -euo pipefail
cd "$(dirname "$0")"
python3 sync_changelog.py
python3 sync_reports.py
python3 build_admin.py
for f in ../index.html ../admin.html ../client.html; do
  python3 - "$f" <<'PY'
import re, sys, subprocess, tempfile, os
s = open(sys.argv[1]).read()
for i, m in enumerate(re.finditer(r'<script(?![^>]*\bsrc=)(?![^>]*type="text/plain")[^>]*>([\s\S]*?)</script>', s)):
    f = os.path.join(tempfile.gettempdir(), 'pestis-check.js'); open(f, 'w').write(m.group(1))
    r = subprocess.run(['node', '--check', f], capture_output=True, text=True)
    if r.returncode: sys.exit(f'{sys.argv[1]}: script {i} has a syntax error:\n{r.stderr[:600]}')
print('checked', sys.argv[1])
PY
done
