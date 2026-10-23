#!/usr/bin/env bash
# Brings the apps up to date with GitHub (run every 2 minutes by cron; safe to run by hand too).
# config.js (made on the server) isn't in GitHub, so it's never touched.
set -euo pipefail
APP=/opt/pestis/app
export GIT_SSH_COMMAND="ssh -i /root/.ssh/pestis_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
cd "$APP"
git fetch -q origin
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$branch")" ]; then
    git reset -q --hard "origin/$branch"
    echo "$(date -Is) updated to $(git log -1 --format='%h %s')" >> /var/log/pestis-updates.log
fi
