#!/usr/bin/env bash
# Prepare a fresh Ubuntu 24.04 server to run the Business Workspace stack with
# Docker Compose (ADR-012). Idempotent: safe to run again.
#
#   sudo MAIL_HOSTNAME=mail.example.com ACME_EMAIL=ops@example.com \
#        infra/server/bootstrap-ubuntu.sh
#
# What it does:
#   1. installs Docker Engine + the compose plugin (Docker's apt repository)
#   2. opens only the ports the stack serves (ufw)
#   3. gets a Let's Encrypt certificate for MAIL_HOSTNAME (certbot, HTTP-01)
#      and installs a renewal hook that copies it into the mail-tls volume
#   4. sets the hostname so HELO/PTR line up
# What it does NOT do (provider/DNS steps — see infra/README.md):
#   reverse DNS (PTR), unblocking outbound port 25, DNS records, relay account.
set -euo pipefail
: "${MAIL_HOSTNAME:?set MAIL_HOSTNAME, e.g. mail.example.com}"
: "${ACME_EMAIL:?set ACME_EMAIL for certificate expiry notices}"
APP_DIR="${APP_DIR:-/opt/business-workspace}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg ufw certbot

# 1. Docker Engine
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

# 2. Firewall: SSH, web, mail. IMAP/POP3 only over TLS (993/995) from outside.
ufw allow OpenSSH
ufw allow 80/tcp      # Let's Encrypt HTTP-01 + redirect to HTTPS
ufw allow 443/tcp     # web app + API behind a reverse proxy
ufw allow 25/tcp      # inbound mail (MX)
ufw allow 587/tcp     # submission (mail clients)
ufw allow 993/tcp     # IMAPS
ufw allow 995/tcp     # POP3S
ufw --force enable

# 3. TLS certificate for the mail hostname.
hostnamectl set-hostname "$MAIL_HOSTNAME"
if [ ! -d "/etc/letsencrypt/live/$MAIL_HOSTNAME" ]; then
  certbot certonly --standalone --non-interactive --agree-tos -m "$ACME_EMAIL" -d "$MAIL_HOSTNAME"
fi
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/business-workspace-mail.sh <<HOOK
#!/usr/bin/env bash
# Copy the renewed certificate into the stack's mail-tls volume and reload.
set -euo pipefail
VOL=\$(docker volume inspect business-workspace_mail-tls --format '{{ .Mountpoint }}')
install -m 644 /etc/letsencrypt/live/$MAIL_HOSTNAME/fullchain.pem "\$VOL/fullchain.pem"
install -m 640 /etc/letsencrypt/live/$MAIL_HOSTNAME/privkey.pem   "\$VOL/privkey.pem"
cd $APP_DIR/infra/compose && docker compose restart postfix dovecot
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/business-workspace-mail.sh

mkdir -p "$APP_DIR"
cat <<EOF

Server prepared. Next:
  1. Put the repos in $APP_DIR (backend/, frontend/, infra/).
  2. cd $APP_DIR/infra/compose && cp .env.example .env && edit .env
     (MAIL_HOSTNAME=$MAIL_HOSTNAME, real secrets, relay credentials).
  3. docker compose up -d --build
  4. Run the renewal hook once to install the certificate:
     /etc/letsencrypt/renewal-hooks/deploy/business-workspace-mail.sh
  5. Provider/DNS checklist: infra/README.md ("Going live").
EOF
