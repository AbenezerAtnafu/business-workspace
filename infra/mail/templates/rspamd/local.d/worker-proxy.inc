# Milter for Postfix (inbound scanning + outbound DKIM signing).
milter = yes;
timeout = 120s;
bind_socket = "*:${RSPAMD_MILTER_PORT}";
upstream "local" {
  default = yes;
  self_scan = yes;
}
