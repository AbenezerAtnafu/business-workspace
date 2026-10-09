#!/usr/bin/env bash
# Render the mail-server configuration from infra/mail/templates.
#
#   render.sh <postfix|dovecot|rspamd|all> [dest-root]
#
# One script, used by every way of running the stack — the Docker images'
# entrypoints, scripts/native-up.sh on a plain Ubuntu VM, and CI — so the
# configuration under test is exactly the one that ships (ADR-012).
#
# Only the variables listed in VARS are substituted, so Postfix's and
# Rspamd's own "$name" syntax passes through untouched. Every variable has a
# development default; production values come from the environment.
set -euo pipefail

COMPONENT="${1:?usage: render.sh <postfix|dovecot|rspamd|all> [dest-root]}"
DEST="${2:-/}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TPL="$HERE/templates"

# ---- defaults (development) -------------------------------------------------
: "${MAIL_HOSTNAME:=mail.localhost}"
: "${MAIL_INET_PROTOCOLS:=ipv4}"
: "${MAIL_DB_HOST:=127.0.0.1}"
: "${MAIL_DB_PORT:=5432}"
: "${MAIL_DB_NAME:=business_workspace}"
: "${MAIL_DB_USER:=mail_reader}"
: "${MAIL_DB_PASSWORD:=mail_reader_dev_password}"
: "${DOVECOT_HOST:=127.0.0.1}"
: "${DOVECOT_LMTP_PORT:=24}"
: "${DOVECOT_AUTH_PORT:=12345}"
: "${DOVECOT_QUOTA_STATUS_PORT:=12340}"
: "${RSPAMD_HOST:=127.0.0.1}"
: "${RSPAMD_MILTER_PORT:=11332}"
: "${RSPAMD_LOCAL_ADDRS:=\"127.0.0.0/8\", \"::1\"}"
: "${REDIS_HOST:=127.0.0.1}"
: "${CLAMAV_MILTER:=}"                     # e.g. inet:clamav:7357 — optional
: "${MILTER_DEFAULT_ACTION:=tempfail}"      # never pass mail unscanned in prod
: "${INTERNAL_SUBMIT_PORT:=10025}"
: "${INTERNAL_SUBMIT_NETWORKS:=127.0.0.0/8}"
: "${RELAY_HOST:=}"                         # e.g. [mailpit]:1025 or [email-smtp.<region>.amazonaws.com]:587
: "${RELAY_USER:=}"
: "${RELAY_PASSWORD:=}"
: "${RELAY_TLS_LEVEL:=may}"                 # 'encrypt' for a real relay
: "${MAIL_ROOT:=/var/mail/vmail}"
: "${MAIL_UID:=5000}"
: "${MAIL_GID:=5000}"
: "${DKIM_KEY_DIR:=/var/lib/rspamd/dkim}"
: "${TLS_CERT_FILE:=/etc/ssl/mail/fullchain.pem}"
: "${TLS_KEY_FILE:=/etc/ssl/mail/privkey.pem}"
: "${DOVECOT_MASTER_USER:=apimaster}"
: "${DOVECOT_MASTER_PASSWORD:=apimaster_dev_password}"
: "${DOVECOT_MASTER_ALLOW_NETS:=127.0.0.1}"

MILTERS="inet:${RSPAMD_HOST}:${RSPAMD_MILTER_PORT}${CLAMAV_MILTER:+ ${CLAMAV_MILTER}}"
RELAY_SASL_ENABLE=$([ -n "$RELAY_USER" ] && echo yes || echo no)
export MAIL_HOSTNAME MAIL_INET_PROTOCOLS MAIL_DB_HOST MAIL_DB_PORT MAIL_DB_NAME MAIL_DB_USER MAIL_DB_PASSWORD \
  DOVECOT_HOST DOVECOT_LMTP_PORT DOVECOT_AUTH_PORT DOVECOT_QUOTA_STATUS_PORT RSPAMD_HOST RSPAMD_MILTER_PORT RSPAMD_LOCAL_ADDRS REDIS_HOST \
  MILTERS MILTER_DEFAULT_ACTION INTERNAL_SUBMIT_PORT INTERNAL_SUBMIT_NETWORKS RELAY_HOST RELAY_TLS_LEVEL \
  RELAY_SASL_ENABLE MAIL_ROOT MAIL_UID MAIL_GID DKIM_KEY_DIR TLS_CERT_FILE TLS_KEY_FILE

VARS='${MAIL_HOSTNAME} ${MAIL_INET_PROTOCOLS} ${MAIL_DB_HOST} ${MAIL_DB_PORT} ${MAIL_DB_NAME} ${MAIL_DB_USER} ${MAIL_DB_PASSWORD} ${DOVECOT_HOST} ${DOVECOT_LMTP_PORT} ${DOVECOT_AUTH_PORT} ${DOVECOT_QUOTA_STATUS_PORT} ${RSPAMD_HOST} ${RSPAMD_MILTER_PORT} ${RSPAMD_LOCAL_ADDRS} ${REDIS_HOST} ${MILTERS} ${MILTER_DEFAULT_ACTION} ${INTERNAL_SUBMIT_PORT} ${INTERNAL_SUBMIT_NETWORKS} ${RELAY_HOST} ${RELAY_TLS_LEVEL} ${RELAY_SASL_ENABLE} ${MAIL_ROOT} ${MAIL_UID} ${MAIL_GID} ${DKIM_KEY_DIR} ${TLS_CERT_FILE} ${TLS_KEY_FILE}'

render() { # <template> <dest> [mode] [owner]
  local src="$TPL/$1" dst="$DEST$2" mode="${3:-644}" owner="${4:-}"
  mkdir -p "$(dirname "$dst")"
  envsubst "$VARS" < "$src" > "$dst"
  chmod "$mode" "$dst"
  if [ -n "$owner" ]; then chown "$owner" "$dst" 2>/dev/null || true; fi
}

ensure_tls() {
  local cert="$DEST$TLS_CERT_FILE" key="$DEST$TLS_KEY_FILE"
  if [ ! -s "$cert" ] || [ ! -s "$key" ]; then
    echo "render.sh: no TLS certificate at $TLS_CERT_FILE — generating a SELF-SIGNED one (development only)" >&2
    mkdir -p "$(dirname "$cert")" "$(dirname "$key")"
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=${MAIL_HOSTNAME}" \
      -addext "subjectAltName=DNS:${MAIL_HOSTNAME},DNS:localhost" -keyout "$key" -out "$cert" 2>/dev/null
    chmod 640 "$key"
  fi
}

do_postfix() {
  render postfix/main.cf /etc/postfix/main.cf
  render postfix/master.cf /etc/postfix/master.cf
  for f in domains mailboxes aliases sender_logins; do
    render "postfix/pgsql/$f.cf" "/etc/postfix/pgsql/$f.cf" 640 root:postfix
  done
  # Relay credentials (texthash: no postmap step needed).
  local pw="$DEST/etc/postfix/relay_passwd"
  if [ -n "$RELAY_USER" ]; then
    printf '%s %s:%s\n' "$RELAY_HOST" "$RELAY_USER" "$RELAY_PASSWORD" > "$pw"
  else
    : > "$pw"
  fi
  chmod 600 "$pw"
  ensure_tls
}

do_dovecot() {
  render dovecot/dovecot.conf /etc/dovecot/dovecot.conf
  render dovecot/dovecot-sql.conf.ext /etc/dovecot/dovecot-sql.conf.ext 640 root:dovecot
  # Master user for the platform API, hashed (never stored in clear), and only
  # usable from DOVECOT_MASTER_ALLOW_NETS.
  local hash
  hash="$(doveadm pw -s ARGON2ID -p "$DOVECOT_MASTER_PASSWORD")"
  printf '%s:%s::::::allow_nets=%s\n' "$DOVECOT_MASTER_USER" "$hash" "$DOVECOT_MASTER_ALLOW_NETS" \
    > "$DEST/etc/dovecot/master-users"
  chmod 640 "$DEST/etc/dovecot/master-users"
  chown root:dovecot "$DEST/etc/dovecot/master-users" 2>/dev/null || true
  ensure_tls
}

do_rspamd() {
  for f in "$TPL"/rspamd/local.d/*; do
    render "rspamd/local.d/$(basename "$f")" "/etc/rspamd/local.d/$(basename "$f")"
  done
  mkdir -p "$DEST$DKIM_KEY_DIR"
  [ -e "$DEST$DKIM_KEY_DIR/selectors.map" ] || : > "$DEST$DKIM_KEY_DIR/selectors.map"
}

case "$COMPONENT" in
  postfix) do_postfix ;;
  dovecot) do_dovecot ;;
  rspamd)  do_rspamd ;;
  all)     do_postfix; do_dovecot; do_rspamd ;;
  *) echo "unknown component: $COMPONENT" >&2; exit 2 ;;
esac
echo "render.sh: $COMPONENT rendered into ${DEST}"
