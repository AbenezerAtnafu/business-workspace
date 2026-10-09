# Mail stack images (ADR-012). One Dockerfile, one target per daemon:
#   docker build -f infra/mail/Dockerfile --target postfix -t bw-postfix infra/mail
#   docker build -f infra/mail/Dockerfile --target dovecot -t bw-dovecot infra/mail
#   docker build -f infra/mail/Dockerfile --target rspamd  -t bw-rspamd  infra/mail
# Based on ubuntu:24.04 deliberately: the exact package versions the stack was
# verified with natively (Postfix 3.8, Dovecot 2.3.21, Rspamd 3.8) — see
# infra/scripts/native-up.sh and backend/scripts/mail-live-test.mjs.
FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends gettext-base openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY render.sh /opt/mail/render.sh
COPY templates /opt/mail/templates
RUN chmod +x /opt/mail/render.sh

FROM base AS postfix
RUN echo "postfix postfix/main_mailer_type select No configuration" | debconf-set-selections \
 && apt-get update \
 && apt-get install -y --no-install-recommends postfix postfix-pgsql \
 && rm -rf /var/lib/apt/lists/*
COPY entrypoints/postfix.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 25 587 10025
HEALTHCHECK --interval=30s --timeout=5s CMD postfix status || exit 1
ENTRYPOINT ["tini", "--", "/entrypoint.sh"]

FROM base AS dovecot
RUN apt-get update \
 && apt-get install -y --no-install-recommends dovecot-core dovecot-imapd dovecot-pop3d dovecot-lmtpd dovecot-pgsql \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 5000 vmail && useradd -u 5000 -g vmail -d /var/mail/vmail -s /usr/sbin/nologin vmail \
 && mkdir -p /var/mail/vmail && chown vmail:vmail /var/mail/vmail
COPY entrypoints/dovecot.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
VOLUME /var/mail/vmail
EXPOSE 24 110 143 993 995 12340 12345
HEALTHCHECK --interval=30s --timeout=5s CMD doveadm service status >/dev/null || exit 1
ENTRYPOINT ["tini", "--", "/entrypoint.sh"]

FROM base AS rspamd
RUN apt-get update \
 && apt-get install -y --no-install-recommends rspamd \
 && rm -rf /var/lib/apt/lists/*
COPY entrypoints/rspamd.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 11332
ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
