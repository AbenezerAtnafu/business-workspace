# Mail from these networks (the API's internal submission) is "local" and
# gets DKIM-signed; authenticated submission is signed too (dkim_signing.conf).
local_addrs = [${RSPAMD_LOCAL_ADDRS}];
dns {
  timeout = 2s;
  retransmits = 2;
}
