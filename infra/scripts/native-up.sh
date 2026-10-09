#!/usr/bin/env bash
# Run the whole mail stack directly on an Ubuntu 24.04 host (no Docker):
# a dev VM, a CI runner, or the build sandbox. Uses the same render.sh and
# templates as the container images, so what passes here is what ships.
#
#   sudo infra/scripts/native-up.sh            # install (first time) + render + start
#   sudo infra/scripts/native-up.sh --no-install
#
# Expects Postgres reachable at MAIL_DB_HOST with migrations 000–015 applied.
# Environment variables are the ones documented in infra/mail/render.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${1:-}" != "--no-install" ]; then
  export DEBIAN_FRONTEND=noninteractive
  echo "postfix postfix/main_mailer_type select No configuration" | debconf-set-selections
  apt-get install -y -q --no-install-recommends \
    postfix postfix-pgsql dovecot-core dovecot-imapd dovecot-pop3d dovecot-lmtpd dovecot-pgsql \
    rspamd redis-server gettext-base openssl ca-certificates >/dev/null
fi

: "${MAIL_UID:=5000}" "${MAIL_GID:=5000}" "${MAIL_ROOT:=/var/mail/vmail}" "${DKIM_KEY_DIR:=/var/lib/rspamd/dkim}"
getent group vmail >/dev/null || groupadd -g "$MAIL_GID" vmail
getent passwd vmail >/dev/null || useradd -u "$MAIL_UID" -g vmail -d "$MAIL_ROOT" -s /usr/sbin/nologin vmail
mkdir -p "$MAIL_ROOT" "$DKIM_KEY_DIR"
chown vmail:vmail "$MAIL_ROOT"

"$HERE/mail/render.sh" all /
chown -R _rspamd:_rspamd "$DKIM_KEY_DIR" 2>/dev/null || true

# (Re)start in dependency order. No systemd assumed (works in containers/CI too).
postfix stop >/dev/null 2>&1 || true
doveadm stop >/dev/null 2>&1 || true
pkill -x rspamd 2>/dev/null || true
redis-cli shutdown nosave >/dev/null 2>&1 || true
sleep 2
redis-server --daemonize yes --bind 127.0.0.1 --save '' >/dev/null
mkdir -p /run/rspamd && chown _rspamd:_rspamd /run/rspamd
rspamd -u _rspamd -g _rspamd
dovecot
postfix check
postfix start
sleep 2
echo "native-up: postfix, dovecot, rspamd, redis running"
