#!/usr/bin/env bash
set -euo pipefail
/opt/mail/render.sh rspamd /
mkdir -p /run/rspamd && chown _rspamd:_rspamd /run/rspamd
chown -R _rspamd:_rspamd "${DKIM_KEY_DIR:-/var/lib/rspamd/dkim}" 2>/dev/null || true
exec rspamd -f -u _rspamd -g _rspamd
