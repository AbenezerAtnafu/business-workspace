#!/usr/bin/env bash
set -euo pipefail
/opt/mail/render.sh dovecot /
chown vmail:vmail /var/mail/vmail
exec dovecot -F
