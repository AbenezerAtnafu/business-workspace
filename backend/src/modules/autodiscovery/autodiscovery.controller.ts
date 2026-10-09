import { Controller, Get, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { AutodiscoveryService } from './autodiscovery.service';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractDomain(email: string): string | null {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) {
    return null;
  }
  return trimmed.slice(at + 1).toLowerCase();
}

/**
 * Autodiscovery responders — architecture/api-contract.md §7: "deliberately
 * not listed [in the REST resource table] — they're protocol endpoints
 * consumed by third-party mail clients during their own setup flow, not
 * REST resources this frontend calls, and they carry no bearer auth. They
 * live at their protocol-mandated well-known paths ... outside the
 * `/api/v1` namespace this contract governs."
 *
 * Both routes are therefore: (a) excluded from the global '/api/v1' prefix
 * (see main.ts's setGlobalPrefix exclude list — a mail client hits these
 * paths verbatim, it has no way to add a prefix), and (b) @Public(),
 * opting out of the global JwtAuthGuard — a mail client authenticates with
 * the IMAP/SMTP credentials it submits to the resolved server directly, not
 * with this platform's own bearer tokens, and has usually never logged
 * into webmail at all yet.
 *
 * Reachability is honest, not assumed — see ADR-008
 * (architecture/decisions.md): Thunderbird reaches correct settings via its
 * own direct SRV lookup without ever hitting the Autoconfig route below
 * (SRV is pure DNS, Step 2.2); Outlook's SRV fallback resolves
 * `_autodiscover._tcp.<domain>` to the platform's own shared hostname and
 * then POSTs straight to that host, i.e. to the Autodiscover route below —
 * no customer-side proxying needed for that path. A client that instead
 * tries the HTTP well-known paths at the CUSTOMER's own domain first (the
 * conventional `autoconfig.<domain>` / `<domain>/.well-known/...` /
 * `autodiscover.<domain>` lookups) will not reach this responder unless the
 * customer separately points that hostname/path at the platform — which is
 * not part of the documented DNS checklist and is flagged, not silently
 * glossed over, in ADR-008.
 */
@Controller()
export class AutodiscoveryController {
  constructor(private readonly autodiscovery: AutodiscoveryService) {}

  /**
   * Mozilla Autoconfig (Thunderbird and others).
   * GET /.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user@domain.com
   */
  @Public()
  @Get('.well-known/autoconfig/mail/config-v1.1.xml')
  async autoconfig(@Query('emailaddress') emailaddress: string | undefined, @Res() res: Response): Promise<void> {
    const domain = emailaddress ? extractDomain(emailaddress) : null;
    if (!domain) {
      res.status(HttpStatus.BAD_REQUEST).type('text/plain').send('emailaddress query parameter is required.');
      return;
    }

    const resolved = await this.autodiscovery.resolveForDomain(domain);
    if (!resolved) {
      // Mozilla's own Autoconfig spec: an ISP that doesn't offer
      // autoconfiguration for a domain should be answered "with a 404
      // error" — this lets a real client fall through to its next
      // discovery step (ISPDB, MX-guessing, SRV) instead of being told
      // anything false about a domain this platform never verified.
      res.status(HttpStatus.NOT_FOUND).send();
      return;
    }

    const safeDomain = escapeXml(domain);
    const safeHost = escapeXml(resolved.host);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${safeDomain}">
    <domain>${safeDomain}</domain>
    <displayName>${safeDomain} Mail</displayName>
    <displayShortName>${safeDomain}</displayShortName>
    <incomingServer type="imap">
      <hostname>${safeHost}</hostname>
      <port>${resolved.imapsPort}</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${safeHost}</hostname>
      <port>${resolved.submissionPort}</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;
    res.status(HttpStatus.OK).type('application/xml').send(xml);
  }

  /**
   * Microsoft Autodiscover (Outlook) — POX protocol,
   * outlook/responseschema/2006a. Real clients POST an XML body containing
   * `<EMailAddress>` (main.ts registers a text() body parser for
   * text/xml and application/xml specifically so `req.body` is the raw
   * string here, since Nest's default body parser only handles JSON).
   */
  @Public()
  @Post('autodiscover/autodiscover.xml')
  async autodiscover(@Req() req: Request, @Res() res: Response): Promise<void> {
    const body = typeof req.body === 'string' ? req.body : '';
    const match = body.match(/<EMailAddress>\s*([^<]+?)\s*<\/EMailAddress>/i);
    const email = match?.[1];
    const domain = email ? extractDomain(email) : null;

    if (!domain) {
      res
        .status(HttpStatus.BAD_REQUEST)
        .type('application/xml')
        .send(this.errorXml('Invalid Request — <EMailAddress> not found in request body.'));
      return;
    }

    const resolved = await this.autodiscovery.resolveForDomain(domain);
    if (!resolved) {
      res
        .status(HttpStatus.NOT_FOUND)
        .type('application/xml')
        .send(this.errorXml(`No autodiscovery configuration for domain '${domain}'.`));
      return;
    }

    const safeEmail = escapeXml(email!.trim());
    const safeHost = escapeXml(resolved.host);
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${safeHost}</Server>
        <Port>${resolved.imapsPort}</Port>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <SSL>on</SSL>
        <AuthRequired>on</AuthRequired>
        <LoginName>${safeEmail}</LoginName>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${safeHost}</Server>
        <Port>${resolved.submissionPort}</Port>
        <DomainRequired>off</DomainRequired>
        <SPA>off</SPA>
        <Encryption>TLS</Encryption>
        <AuthRequired>on</AuthRequired>
        <LoginName>${safeEmail}</LoginName>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>`;
    res.status(HttpStatus.OK).type('application/xml').send(xml);
  }

  private errorXml(message: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Error Time="${new Date().toISOString()}" Id="0">
      <ErrorCode>600</ErrorCode>
      <Message>${escapeXml(message)}</Message>
    </Error>
  </Response>
</Autodiscover>`;
  }
}
